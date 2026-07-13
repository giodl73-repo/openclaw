import { describe, expect, it, vi } from "vitest";
import {
  NETWORK_GUARD_PROFILE_VERSION,
  type NetworkGuardProfileV1,
} from "../infra/net/network-guard-profile.js";
import {
  REVERSE_PROVIDER_DISPATCH_VERSION,
  type ReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchTraceResult,
} from "../infra/net/reverse-provider-dispatch.js";
import {
  createHostProviderOneHopFetchDispatcherV1,
  HostProviderDispatchError,
} from "./host-provider-dispatcher.js";
import type {
  HostProviderOperation,
  HostProviderOperationOpenInput,
  HostProviderRegistry,
} from "./host-provider-registry.js";

type HostProviderOperationFrameInput = ReverseProviderDispatchFrameV1 extends infer TFrame
  ? TFrame extends ReverseProviderDispatchFrameV1
    ? Omit<
        TFrame,
        "version" | "incarnationId" | "operationId" | "ownerGeneration" | "hostBundleGeneration"
      >
    : never
  : never;

function networkGuard(): NetworkGuardProfileV1 {
  return {
    version: NETWORK_GUARD_PROFILE_VERSION,
    target: {
      protocol: "https:",
      origin: "https://capi.example.com",
      hostname: "capi.example.com",
      port: 443,
    },
    route: {
      mode: "explicit-proxy",
      resolution: "proxy",
      tls: "required",
    },
    addressPolicy: {
      mode: "public-only",
      trustedHostnames: [],
      hostnameAllowlist: [],
      allowedPrivateCidrs: [],
      allowRfc2544BenchmarkRange: false,
      allowIpv6UniqueLocalRange: false,
      dnsRebinding: {
        policy: "reject",
        enforcement: "connection-owner-required",
      },
    },
  };
}

function withBase(
  operation: HostProviderOperation,
  frame: HostProviderOperationFrameInput,
): ReverseProviderDispatchFrameV1 {
  return {
    ...frame,
    version: REVERSE_PROVIDER_DISPATCH_VERSION,
    incarnationId: operation.open.incarnationId,
    operationId: operation.open.operationId,
    ownerGeneration: operation.open.ownerGeneration,
    hostBundleGeneration: operation.open.hostBundleGeneration,
  } as ReverseProviderDispatchFrameV1;
}

function fakeRegistry(params: {
  requestCredits?: number[];
  responseFrames: (
    operation: HostProviderOperation,
    requestBody: Uint8Array,
  ) => ReverseProviderDispatchFrameV1[];
}) {
  let opened: HostProviderOperationOpenInput | undefined;
  let requestBody = Buffer.alloc(0);
  let requestCredit = 0;
  const openOperation = vi.fn((input: HostProviderOperationOpenInput): HostProviderOperation => {
    opened = input;
    let controller!: ReadableStreamDefaultController<ReverseProviderDispatchFrameV1>;
    const frames = new ReadableStream<ReverseProviderDispatchFrameV1>({
      start(next) {
        controller = next;
      },
    });
    let resolveResult!: (result: ReverseProviderDispatchTraceResult) => void;
    const result = new Promise<ReverseProviderDispatchTraceResult>((resolve) => {
      resolveResult = resolve;
    });
    const operation = {
      open: {
        ...input,
        version: REVERSE_PROVIDER_DISPATCH_VERSION,
        type: "operation-open" as const,
        incarnationId: "incarnation-1",
        ownerGeneration: "dispatcher-owner-4",
        hostBundleGeneration: "lobster/host@1.0.0",
      },
      frames,
      result,
      send(frame: ReverseProviderDispatchFrameV1) {
        if (frame.type === "chunk" && frame.stream === "request") {
          if (Buffer.from(frame.payloadBase64, "base64").byteLength > requestCredit) {
            return false;
          }
          requestCredit -= Buffer.from(frame.payloadBase64, "base64").byteLength;
          requestBody = Buffer.concat([requestBody, Buffer.from(frame.payloadBase64, "base64")]);
        }
        if (frame.type === "half-close" && frame.stream === "request") {
          const responseFrames = params.responseFrames(operation, requestBody);
          for (const responseFrame of responseFrames) {
            controller.enqueue(responseFrame);
          }
          const terminal = responseFrames.at(-1);
          controller.close();
          resolveResult(
            terminal?.type === "terminal" && terminal.outcome === "completed"
              ? {
                  ok: true,
                  terminal: {
                    outcome: "completed",
                    certainty: "completed",
                  },
                  cancelled: false,
                  ignoredFrames: 0,
                }
              : {
                  ok: true,
                  terminal: {
                    outcome: "failed",
                    certainty:
                      terminal?.type === "terminal" ? terminal.certainty : "started-unconfirmed",
                    failureCode:
                      terminal?.type === "terminal" ? terminal.failureCode : "protocol-violation",
                  },
                  cancelled: false,
                  ignoredFrames: 0,
                },
          );
        }
        return true;
      },
    } satisfies HostProviderOperation;
    queueMicrotask(() => {
      for (const bytes of params.requestCredits ?? [input.requestByteLimit]) {
        requestCredit += bytes;
        controller.enqueue(
          withBase(operation, {
            type: "credit",
            stream: "request",
            bytes,
          }),
        );
      }
    });
    return operation;
  });
  return {
    registry: { openOperation } as unknown as HostProviderRegistry,
    openOperation,
    get opened() {
      return opened;
    },
    get requestBody() {
      return requestBody;
    },
  };
}

describe("host provider one-hop dispatcher", () => {
  it("streams one request and reconstructs the host response without following redirects", async () => {
    const fake = fakeRegistry({
      responseFrames: (operation) => [
        withBase(operation, { type: "dispatch-started" }),
        withBase(operation, {
          type: "response-open",
          status: 307,
          statusText: "Temporary Redirect",
          headers: { location: "https://other.example/final" },
        }),
        withBase(operation, {
          type: "chunk",
          stream: "response",
          sequence: 0,
          payloadBase64: Buffer.from("redirect").toString("base64"),
        }),
        withBase(operation, { type: "half-close", stream: "response" }),
        withBase(operation, {
          type: "terminal",
          outcome: "completed",
          certainty: "completed",
        }),
      ],
    });
    const dispatcher = createHostProviderOneHopFetchDispatcherV1({
      registry: fake.registry,
      bindingId: "lobster/egress",
      routeProfile: "lobster/managed",
      maxChunkBytes: 4,
      createAuditCorrelation: () => "audit-1",
    });

    const response = await dispatcher.dispatch({
      url: "https://capi.example.com/v1/messages",
      init: {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: "request-body",
      },
      networkGuard: networkGuard(),
      credentialSlotRefs: ["lobster/capi-token"],
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://other.example/final");
    await expect(response.text()).resolves.toBe("redirect");
    expect(fake.requestBody.toString()).toBe("request-body");
    expect(fake.opened?.request).toMatchObject({
      credentialSlotRefs: ["lobster/capi-token"],
      routeProfile: "lobster/managed",
      auditCorrelation: "audit-1",
    });
  });

  it("preserves dispatch certainty when the host fails before response headers", async () => {
    const fake = fakeRegistry({
      responseFrames: (operation) => [
        withBase(operation, { type: "dispatch-started" }),
        withBase(operation, {
          type: "terminal",
          outcome: "failed",
          certainty: "started-unconfirmed",
          failureCode: "connection-lost",
        }),
      ],
    });

    const dispatcher = createHostProviderOneHopFetchDispatcherV1({
      registry: fake.registry,
      bindingId: "lobster/egress",
      routeProfile: "lobster/managed",
    });

    await expect(
      dispatcher.dispatch({
        url: "https://capi.example.com/v1/messages",
        init: {
          method: "POST",
          redirect: "manual",
          body: "request",
        },
        networkGuard: networkGuard(),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HostProviderDispatchError>>({
        failureCode: "connection-lost",
        certainty: "started-unconfirmed",
      }),
    );
  });

  it("never sends more request bytes than the host has credited", async () => {
    const fake = fakeRegistry({
      requestCredits: [3, 2, 7],
      responseFrames: (operation) => [
        withBase(operation, { type: "dispatch-started" }),
        withBase(operation, {
          type: "response-open",
          status: 200,
          statusText: "OK",
          headers: {},
        }),
        withBase(operation, { type: "half-close", stream: "response" }),
        withBase(operation, {
          type: "terminal",
          outcome: "completed",
          certainty: "completed",
        }),
      ],
    });
    const dispatcher = createHostProviderOneHopFetchDispatcherV1({
      registry: fake.registry,
      bindingId: "lobster/egress",
      routeProfile: "lobster/managed",
      maxChunkBytes: 8,
    });

    const response = await dispatcher.dispatch({
      url: "https://capi.example.com/v1/messages",
      init: {
        method: "POST",
        redirect: "manual",
        body: "request-body",
      },
      networkGuard: networkGuard(),
    });

    expect(response.status).toBe(200);
    expect(fake.requestBody.toString()).toBe("request-body");
  });
});
