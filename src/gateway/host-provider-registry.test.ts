import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ReverseProviderDispatchFrameV1 } from "../infra/net/reverse-provider-dispatch.js";
import {
  HostProviderRegistry,
  type HostProviderOperationOpenInput,
} from "./host-provider-registry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function socket() {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function client(
  connId: string,
  socketValue = socket(),
  ownerGeneration = "owner-4",
): GatewayWsClient {
  return {
    connId,
    socket: socketValue as unknown as GatewayWsClient["socket"],
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 5,
      maxProtocol: 5,
      client: {
        id: "host-provider",
        version: "1.0.0",
        platform: "linux",
        mode: "service",
      },
      role: "host-provider",
      scopes: [],
      hostProvider: {
        bindingId: "lobster/egress",
        interfaceVersion: "provider-request-dispatcher/v1",
        carrierVersion: "reverse-provider-dispatch/v1",
        ownerGeneration,
        hostBundleGeneration: "lobster/host@1.0.0",
      },
    },
    internal: {
      hostProvider: {
        declaration: {
          bindingId: "lobster/egress",
          interfaceVersion: "provider-request-dispatcher/v1",
          carrierVersion: "reverse-provider-dispatch/v1",
          ownerGeneration,
          hostBundleGeneration: "lobster/host@1.0.0",
        },
        credentialId: "credential-1",
        peerKeyFingerprint: "peer-1",
      },
    },
  };
}

function openInput(operationId: string): HostProviderOperationOpenInput {
  return {
    operationId,
    bindingId: "lobster/egress",
    deadlineMs: 30_000,
    requestByteLimit: 1024,
    responseByteLimit: 2048,
    maxFrameBytes: 4096,
    maxChunkBytes: 256,
    request: {
      method: "POST",
      url: "https://api.dispatch.test/v1",
      headers: { "content-type": "application/json" },
      credentialSlotRefs: ["lobster/capi-token"],
      routeProfile: "lobster/managed-egress",
      networkGuard: {
        version: "network-guard/v1" as const,
        target: {
          protocol: "https:" as const,
          origin: "https://api.dispatch.test",
          hostname: "api.dispatch.test",
          port: 443,
        },
        route: {
          mode: "managed-proxy" as const,
          resolution: "proxy" as const,
          tls: "required" as const,
        },
        addressPolicy: {
          mode: "public-only" as const,
          trustedHostnames: [],
          hostnameAllowlist: ["api.dispatch.test"],
          allowedPrivateCidrs: [],
          allowRfc2544BenchmarkRange: false,
          allowIpv6UniqueLocalRange: false,
          dnsRebinding: {
            policy: "reject" as const,
            enforcement: "connection-owner-required" as const,
          },
        },
      },
      auditCorrelation: `audit-${operationId}`,
    },
  };
}

type CarrierFrameInput = ReverseProviderDispatchFrameV1 extends infer TFrame
  ? TFrame extends ReverseProviderDispatchFrameV1
    ? Omit<
        TFrame,
        "version" | "incarnationId" | "operationId" | "ownerGeneration" | "hostBundleGeneration"
      >
    : never
  : never;

function frame(
  open: ReturnType<HostProviderRegistry["openOperation"]>["open"],
  value: CarrierFrameInput,
): ReverseProviderDispatchFrameV1 {
  return {
    version: open.version,
    incarnationId: open.incarnationId,
    operationId: open.operationId,
    ownerGeneration: open.ownerGeneration,
    hostBundleGeneration: open.hostBundleGeneration,
    ...value,
  } as ReverseProviderDispatchFrameV1;
}

async function nextTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const registries: HostProviderRegistry[] = [];

function registry() {
  const value = new HostProviderRegistry(() => true);
  registries.push(value);
  return value;
}

afterEach(() => {
  for (const value of registries.splice(0)) {
    value.shutdown();
  }
});

describe("host provider registry", () => {
  it("delivers one frame per turn and completes a synthetic carrier operation", async () => {
    const providerSocket = socket();
    const value = registry();
    const provider = client("conn-1", providerSocket);
    value.register(provider);
    const operation = value.openOperation(openInput("operation-1"));
    operation.send(frame(operation.open, { type: "half-close", stream: "request" }));

    expect(providerSocket.send).not.toHaveBeenCalled();
    await nextTurn();
    expect(providerSocket.send).toHaveBeenCalledTimes(1);
    await nextTurn();
    expect(providerSocket.send).toHaveBeenCalledTimes(2);

    value.receiveFrame(provider.connId, frame(operation.open, { type: "dispatch-started" }));
    value.receiveFrame(
      provider.connId,
      frame(operation.open, {
        type: "response-open",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      }),
    );
    operation.send(frame(operation.open, { type: "credit", stream: "response", bytes: 2 }));
    value.receiveFrame(
      provider.connId,
      frame(operation.open, {
        type: "chunk",
        stream: "response",
        sequence: 0,
        payloadBase64: "b2s=",
      }),
    );
    value.receiveFrame(
      provider.connId,
      frame(operation.open, { type: "half-close", stream: "response" }),
    );
    value.receiveFrame(
      provider.connId,
      frame(operation.open, {
        type: "terminal",
        outcome: "completed",
        certainty: "completed",
      }),
    );

    await expect(operation.result).resolves.toEqual({
      ok: true,
      terminal: { outcome: "completed", certainty: "completed" },
      cancelled: false,
      ignoredFrames: 0,
    });
  });

  it("settles old operations without replay when a session is superseded", async () => {
    const firstSocket = socket();
    const value = registry();
    value.register(client("conn-1", firstSocket));
    const operation = value.openOperation(openInput("operation-1"));
    value.receiveFrame("conn-1", frame(operation.open, { type: "dispatch-started" }));

    const second = value.register(client("conn-2", socket(), "owner-5"));

    expect(second.incarnationId).not.toBe(operation.open.incarnationId);
    expect(second.ownerGeneration).toBe("owner-5");
    expect(firstSocket.close).toHaveBeenCalledWith(4001, "host provider superseded");
    await expect(operation.result).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: "started-unconfirmed",
          failureCode: "connection-lost",
        },
      }),
    );
  });

  it("closes a slow provider and bounds active operations", async () => {
    const slowSocket = socket();
    slowSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const slowRegistry = registry();
    slowRegistry.register(client("conn-slow", slowSocket));
    const slowOperation = slowRegistry.openOperation(openInput("operation-slow"));
    await nextTurn();

    expect(slowSocket.close).toHaveBeenCalledWith(1008, "slow consumer");
    await expect(slowOperation.result).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        terminal: expect.objectContaining({ failureCode: "connection-lost" }),
      }),
    );

    const capacityRegistry = registry();
    capacityRegistry.register(client("conn-capacity"));
    for (let index = 0; index < 64; index += 1) {
      capacityRegistry.openOperation(openInput(`operation-${index}`));
    }
    expect(() => capacityRegistry.openOperation(openInput("operation-overflow"))).toThrow(
      "operation capacity exceeded",
    );
  });

  it("fails an operation before dispatch when its outbound queue is full", async () => {
    const value = registry();
    value.register(client("conn-queue"));
    const operation = value.openOperation(openInput("operation-queue"));
    for (let index = 0; index < 255; index += 1) {
      expect(
        operation.send(
          frame(operation.open, {
            type: "credit",
            stream: "response",
            bytes: 1,
          }),
        ),
      ).toBe(true);
    }
    expect(
      operation.send(
        frame(operation.open, {
          type: "credit",
          stream: "response",
          bytes: 1,
        }),
      ),
    ).toBe(false);
    await expect(operation.result).resolves.toEqual({
      ok: true,
      terminal: {
        outcome: "failed",
        certainty: "not-started",
        failureCode: "overloaded",
      },
      cancelled: false,
      ignoredFrames: 0,
    });
  });

  it("settles operations and revokes the session during shutdown", async () => {
    const providerSocket = socket();
    const value = registry();
    value.register(client("conn-shutdown", providerSocket));
    const operation = value.openOperation(openInput("operation-shutdown"));

    value.shutdown();

    expect(providerSocket.close).toHaveBeenCalledWith(4001, "gateway shutdown");
    await expect(operation.result).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: "not-started",
          failureCode: "connection-lost",
        },
      }),
    );
  });

  it("rejects carrier frames sent by the wrong side", () => {
    const value = registry();
    value.register(client("conn-direction"));
    const operation = value.openOperation(openInput("operation-direction"));

    expect(() =>
      value.receiveFrame(
        "conn-direction",
        frame(operation.open, {
          type: "chunk",
          stream: "request",
          sequence: 0,
          payloadBase64: "dGVzdA==",
        }),
      ),
    ).toThrow("frame direction is invalid");
    expect(() =>
      operation.send(
        frame(operation.open, {
          type: "dispatch-started",
        }),
      ),
    ).toThrow("frame direction is invalid");
  });

  it("preserves cancellation state when an active operation times out", async () => {
    vi.useFakeTimers();
    try {
      const value = registry();
      value.register(client("conn-timeout"));
      const operation = value.openOperation({
        ...openInput("operation-timeout"),
        deadlineMs: 10,
      });
      operation.send(
        frame(operation.open, {
          type: "cancel",
          reason: "caller aborted",
        }),
      );

      await vi.advanceTimersByTimeAsync(10);

      await expect(operation.result).resolves.toEqual({
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: "not-started",
          failureCode: "timeout",
        },
        cancelled: true,
        ignoredFrames: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes active operations when owner authority changes", async () => {
    let current = true;
    const value = new HostProviderRegistry(() => current);
    registries.push(value);
    const providerSocket = socket();
    value.register(client("conn-authority", providerSocket));
    const operation = value.openOperation(openInput("operation-authority"));
    value.receiveFrame(
      "conn-authority",
      frame(operation.open, {
        type: "dispatch-started",
      }),
    );

    current = false;
    value.revalidateSessions();

    expect(providerSocket.close).toHaveBeenCalledWith(4001, "host provider authority changed");
    await expect(operation.result).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: "started-unconfirmed",
          failureCode: "connection-lost",
        },
      }),
    );
    expect(() => value.openOperation(openInput("operation-new"))).toThrow(
      "host provider is not connected",
    );
  });
});
