import { describe, expect, it } from "vitest";
import fixtures from "../../../test/fixtures/reverse-provider-dispatch-v1.json" with { type: "json" };
import { evaluateReverseProviderDispatchTraceV1 } from "./reverse-provider-dispatch-trace.js";
import { assertReverseProviderDispatchFrameV1 } from "./reverse-provider-dispatch.js";

type FixtureCase = {
  id: string;
  frames: Array<Record<string, unknown>>;
  openOverrides?: Record<string, unknown>;
  disconnected?: boolean;
  expected: Record<string, unknown>;
};

const operation = fixtures.operation as {
  base: Record<string, unknown>;
  open: Record<string, unknown>;
};

function materializeFrames(fixture: FixtureCase): Array<Record<string, unknown>> {
  return [
    { ...operation.base, ...operation.open, ...fixture.openOverrides },
    ...fixture.frames.map((frame) => ({ ...operation.base, ...frame })),
  ];
}

describe("reverse provider dispatch v1 fixtures", () => {
  for (const fixture of fixtures.cases as FixtureCase[]) {
    it(fixture.id, () => {
      const result = evaluateReverseProviderDispatchTraceV1({
        frames: materializeFrames(fixture),
        disconnected: fixture.disconnected,
        expectedSession: {
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
    ).toThrow("network guard route must be an object");
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
    ).toThrow("enforcement does not match resolution mode");
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
    ).toThrow("TLS posture does not match target protocol");
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
