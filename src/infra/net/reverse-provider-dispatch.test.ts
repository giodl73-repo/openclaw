import { describe, expect, it } from "vitest";
import fixtures from "../../../test/fixtures/reverse-provider-dispatch-v1.json" with { type: "json" };
import { evaluateReverseProviderDispatchTraceV1 } from "./reverse-provider-dispatch-trace.js";
import { assertReverseProviderDispatchFrameV1 } from "./reverse-provider-dispatch.js";

type FixtureCase = {
  id: string;
  frames: Array<Record<string, unknown>>;
  openOverrides?: Record<string, unknown>;
  requestMethod?: string;
  disconnected?: boolean;
  expected: Record<string, unknown>;
};

const operation = fixtures.operation as {
  base: Record<string, unknown>;
  open: Record<string, unknown>;
};

function materializeFrames(fixture: FixtureCase): Array<Record<string, unknown>> {
  const open = { ...operation.base, ...operation.open, ...fixture.openOverrides };
  if (fixture.requestMethod) {
    open.request = {
      ...(open.request as Record<string, unknown>),
      method: fixture.requestMethod,
    };
  }
  return [open, ...fixture.frames.map((frame) => ({ ...operation.base, ...frame }))];
}

describe("reverse provider dispatch v1 fixtures", () => {
  for (const fixture of fixtures.cases as FixtureCase[]) {
    it(fixture.id, () => {
      const result = evaluateReverseProviderDispatchTraceV1({
        frames: materializeFrames(fixture),
        disconnected: fixture.disconnected,
        expectedSession: {
          bindingId: String(operation.open.bindingId),
          incarnationId: String(operation.base.incarnationId),
          ownerGeneration: String(operation.base.ownerGeneration),
          hostBundleGeneration: String(operation.base.hostBundleGeneration),
        },
      });
      expect(result).toMatchObject(fixture.expected);
    });
  }

  it("rejects unknown frame fields and non-canonical chunks", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "credit",
        stream: "request",
        bytes: 1,
        unexpected: true,
      }),
    ).toThrow("unknown field unexpected");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "chunk",
        stream: "request",
        sequence: 0,
        payloadBase64: "not-base64",
      }),
    ).toThrow("canonical base64");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "chunk",
        stream: "request",
        sequence: 0,
        payloadBase64: "AB==",
      }),
    ).toThrow("canonical base64");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "terminal",
        outcome: "failed",
        certainty: "not-started",
        failureCode: "made-up",
      }),
    ).toThrow("requires a failure code");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          networkGuard: {
            ...(operation.open.request as { networkGuard: Record<string, unknown> }).networkGuard,
            route: undefined,
          },
        },
      }),
    ).toThrow("Unsupported network guard route shape");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          networkGuard: {
            ...(operation.open.request as { networkGuard: Record<string, unknown> }).networkGuard,
            addressPolicy: {
              ...(
                operation.open.request as {
                  networkGuard: { addressPolicy: Record<string, unknown> };
                }
              ).networkGuard.addressPolicy,
              dnsRebinding: {
                policy: "reject",
                enforcement: "local-pinned",
              },
            },
          },
        },
      }),
    ).toThrow("Network guard DNS rebinding enforcement is inconsistent");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          networkGuard: {
            ...(operation.open.request as { networkGuard: Record<string, unknown> }).networkGuard,
            route: {
              mode: "managed-proxy",
              resolution: "proxy",
              tls: "cleartext",
            },
          },
        },
      }),
    ).toThrow("Network guard route TLS posture is inconsistent with the target");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          credentialSlotRefs: ["lobster/capi-token"],
        },
      }),
    ).toThrow("unknown field credentialSlotRefs");
  });

  it("rejects ambiguous or injected HTTP headers", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          headers: {
            Authorization: "Bearer one",
            authorization: "Bearer two",
          },
        },
      }),
    ).toThrow("duplicate case-insensitive header names");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          headers: { "x-proof": "ok\r\nx-injected: true" },
        },
      }),
    ).toThrow("invalid HTTP header");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          headers: { "x-proof": "ok\u0000bad" },
        },
      }),
    ).toThrow("invalid HTTP header");
  });

  it("rejects HTTP metadata that Fetch cannot materialize", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          method: "POST /smuggled",
        },
      }),
    ).toThrow("supported by Fetch");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          method: "connect",
        },
      }),
    ).toThrow("supported by Fetch");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          url: "https://user:password@api.dispatch.test/v1",
        },
      }),
    ).toThrow("must not contain credentials");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "response-open",
        status: 199,
        statusText: "Informational",
        headers: {},
      }),
    ).toThrow("supported by Fetch");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "response-open",
        status: 200,
        statusText: "OK\r\nX-Injected: true",
        headers: {},
      }),
    ).toThrow("HTTP reason phrase");
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "response-open",
        status: 200,
        statusText: "snowman ☃",
        headers: {},
      }),
    ).toThrow("HTTP reason phrase");
  });

  it("accepts request URLs longer than bounded identifiers within the negotiated frame", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        request: {
          ...(operation.open.request as Record<string, unknown>),
          url: "https://api.dispatch.test/v1?signature=" + "a".repeat(1024),
        },
      }),
    ).not.toThrow();
  });

  it("rejects frames beyond the fixed wire limit", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        type: "cancel",
        reason: "x".repeat(1024 * 1024),
      }),
    ).toThrow("wire limit");
  });

  it("rejects terminal certainty that contradicts observed dispatch state", () => {
    expect(
      evaluateReverseProviderDispatchTraceV1({
        frames: [
          { ...operation.base, ...operation.open },
          { ...operation.base, type: "dispatch-started" },
          {
            ...operation.base,
            type: "terminal",
            outcome: "failed",
            certainty: "not-started",
            failureCode: "timeout",
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "protocol-violation",
      certainty: "started-unconfirmed",
    });
  });

  it("rejects cumulative credit beyond each stream byte limit", () => {
    for (const stream of ["request", "response"] as const) {
      const frames: Array<Record<string, unknown>> = [
        {
          ...operation.base,
          ...operation.open,
          requestByteLimit: 10,
          responseByteLimit: 10,
          maxChunkBytes: 10,
        },
      ];
      if (stream === "response") {
        frames.push({ ...operation.base, type: "dispatch-started" });
        frames.push({
          ...operation.base,
          type: "response-open",
          status: 200,
          statusText: "OK",
          headers: {},
        });
      }
      frames.push({ ...operation.base, type: "credit", stream, bytes: 10 });
      frames.push({
        ...operation.base,
        type: "chunk",
        stream,
        sequence: 0,
        payloadBase64: "AQIDBAUG",
      });
      frames.push({ ...operation.base, type: "credit", stream, bytes: 6 });

      expect(evaluateReverseProviderDispatchTraceV1({ frames })).toMatchObject({
        ok: false,
        code: "protocol-violation",
      });
    }
  });

  it("rejects duplicate cancellation", () => {
    expect(
      evaluateReverseProviderDispatchTraceV1({
        frames: [
          { ...operation.base, ...operation.open },
          { ...operation.base, type: "cancel", reason: "caller stopped" },
          { ...operation.base, type: "cancel", reason: "caller stopped again" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "protocol-violation",
    });
  });

  it("rejects operation limits whose maximum chunk cannot fit one frame", () => {
    expect(() =>
      assertReverseProviderDispatchFrameV1({
        ...operation.base,
        ...operation.open,
        requestByteLimit: 10000,
        responseByteLimit: 10000,
        maxFrameBytes: 4096,
        maxChunkBytes: 4000,
      }),
    ).toThrow("maxChunkBytes cannot fit within maxFrameBytes");
  });

  it("accounts for sequence growth when checking maximum chunk frame size", () => {
    const open = {
      ...operation.base,
      ...operation.open,
      requestByteLimit: 3000,
      responseByteLimit: 3000,
      maxFrameBytes: 999999,
      maxChunkBytes: 2000,
    };
    const sequenceZeroChunk = {
      ...operation.base,
      type: "chunk",
      stream: "request",
      sequence: 0,
      payloadBase64: "A".repeat(2664) + "AAA=",
    };
    open.maxFrameBytes = Buffer.byteLength(JSON.stringify(sequenceZeroChunk), "utf8");

    expect(() => assertReverseProviderDispatchFrameV1(open)).toThrow(
      "maxChunkBytes cannot fit within maxFrameBytes",
    );
  });

  it("does not replay an incomplete operation without an explicit disconnect", () => {
    expect(
      evaluateReverseProviderDispatchTraceV1({
        frames: [
          { ...operation.base, ...operation.open },
          { ...operation.base, type: "dispatch-started" },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "incomplete-trace",
      certainty: "started-unconfirmed",
    });
  });
});
