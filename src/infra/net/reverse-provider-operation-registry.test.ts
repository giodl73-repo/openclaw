import { describe, expect, it } from "vitest";
import sessionFixtures from "../../../test/fixtures/reverse-provider-session-v1.json" with { type: "json" };
import { REVERSE_PROVIDER_DISPATCH_VERSION } from "./reverse-provider-dispatch.js";
import {
  ReverseProviderOperationRegistryV1,
  REVERSE_PROVIDER_MAX_ACTIVE_OPERATIONS_V1,
} from "./reverse-provider-operation-registry.js";
import {
  ReverseProviderSessionRegistryV1,
  type ReverseProviderSessionV1,
} from "./reverse-provider-session.js";

const NOW_MS = 2_000_000_000_000;

function admit(
  sessions: ReverseProviderSessionRegistryV1,
  bindingId = sessionFixtures.declaration.bindingId,
  connectionId = "connection-1",
): Readonly<ReverseProviderSessionV1> {
  const declaration = { ...sessionFixtures.declaration, bindingId };
  const authority = { ...sessionFixtures.authority, bindingId };
  const result = sessions.admit(
    {
      declaration,
      connectionId,
      verifiedPeer: { ...sessionFixtures.verifiedPeer },
    },
    authority,
    NOW_MS,
  );
  if (!result.ok) {
    throw new Error(`session admission failed: ${result.code}`);
  }
  return result.session;
}

function operationOpen(session: Readonly<ReverseProviderSessionV1>, operationId = "operation-1") {
  return {
    version: REVERSE_PROVIDER_DISPATCH_VERSION,
    type: "operation-open",
    incarnationId: session.incarnationId,
    operationId,
    ownerGeneration: session.declaration.ownerGeneration,
    hostBundleGeneration: session.declaration.hostBundleGeneration,
    bindingId: session.declaration.bindingId,
    timeoutMs: 30_000,
    requestByteLimit: 1024,
    responseByteLimit: 1024,
    maxFrameBytes: 4096,
    maxChunkBytes: 1024,
    request: {
      method: "GET",
      url: "https://example.invalid/weather",
      headers: {},
      routeProfile: "enterprise-egress",
      auditCorrelation: `audit-${operationId}`,
    },
  };
}

function frame(
  session: Readonly<ReverseProviderSessionV1>,
  operationId: string,
  value: Record<string, unknown>,
) {
  return {
    version: REVERSE_PROVIDER_DISPATCH_VERSION,
    incarnationId: session.incarnationId,
    operationId,
    ownerGeneration: session.declaration.ownerGeneration,
    hostBundleGeneration: session.declaration.hostBundleGeneration,
    ...value,
  };
}

describe("ReverseProviderOperationRegistryV1", () => {
  it("claims immutable operation ownership for an exact current session", () => {
    const sessions = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);

    const result = operations.claim(session, operationOpen(session));

    expect(result).toEqual({
      ok: true,
      operation: {
        operationId: "operation-1",
        bindingId: session.declaration.bindingId,
        connectionId: session.connectionId,
        incarnationId: session.incarnationId,
        ownerGeneration: session.declaration.ownerGeneration,
        hostBundleGeneration: session.declaration.hostBundleGeneration,
      },
    });
    expect(result.ok && Object.isFrozen(result.operation)).toBe(true);
    expect(operations.list(session)).toEqual(result.ok ? [result.operation] : []);
    expect(Object.isFrozen(operations.list(session))).toBe(true);
  });

  it("rejects malformed, non-open, and mismatched operation claims", () => {
    const sessions = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);

    expect(operations.claim(session, { type: "operation-open" })).toMatchObject({
      ok: false,
      code: "malformed",
    });
    expect(
      operations.claim(session, frame(session, "operation-1", { type: "dispatch-started" })),
    ).toMatchObject({ ok: false, code: "malformed" });
    expect(
      operations.claim(session, {
        ...operationOpen(session),
        ownerGeneration: "owner-generation-stale",
      }),
    ).toMatchObject({ ok: false, code: "stale-session" });
  });

  it("rejects claims through a detached session", () => {
    const sessions = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);
    sessions.detach(session.connectionId, session.incarnationId);

    expect(operations.claim(session, operationOpen(session))).toMatchObject({
      ok: false,
      code: "stale-session",
    });
  });

  it("rejects new and existing operations when the admitted peer proof expires", () => {
    let nowMs = sessionFixtures.verifiedPeer.expiresAtMs - 1;
    const sessions = new ReverseProviderSessionRegistryV1(
      () => "incarnation-1",
      () => nowMs,
    );
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);
    expect(operations.claim(session, operationOpen(session, "operation-1")).ok).toBe(true);

    nowMs = sessionFixtures.verifiedPeer.expiresAtMs;
    expect(operations.claim(session, operationOpen(session, "operation-2"))).toMatchObject({
      ok: false,
      code: "stale-session",
    });
    expect(
      operations.observe(session, frame(session, "operation-1", { type: "dispatch-started" })),
    ).toMatchObject({ ok: false, code: "stale-session" });
  });

  it("scopes duplicate operation IDs to one session incarnation", () => {
    let sequence = 0;
    const sessions = new ReverseProviderSessionRegistryV1(() => `incarnation-${++sequence}`);
    const first = admit(sessions, "binding.first", "connection-1");
    const second = admit(sessions, "binding.second", "connection-2");
    const operations = new ReverseProviderOperationRegistryV1(sessions);

    expect(operations.claim(first, operationOpen(first)).ok).toBe(true);
    expect(operations.claim(first, operationOpen(first))).toMatchObject({
      ok: false,
      code: "duplicate-operation",
    });
    expect(operations.claim(second, operationOpen(second)).ok).toBe(true);
  });

  it("bounds total active ownership and releases capacity on terminal", () => {
    const sessions = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions, 2);
    expect(REVERSE_PROVIDER_MAX_ACTIVE_OPERATIONS_V1).toBe(64);

    expect(operations.claim(session, operationOpen(session, "operation-1")).ok).toBe(true);
    expect(operations.claim(session, operationOpen(session, "operation-2")).ok).toBe(true);
    expect(operations.claim(session, operationOpen(session, "operation-3"))).toMatchObject({
      ok: false,
      code: "capacity-exceeded",
    });

    expect(
      operations.observe(
        session,
        frame(session, "operation-1", {
          type: "terminal",
          outcome: "completed",
          certainty: "completed",
        }),
      ),
    ).toMatchObject({ ok: true, released: true });
    expect(operations.claim(session, operationOpen(session, "operation-3")).ok).toBe(true);
  });

  it("keeps ownership for non-terminal frames and rejects frames after release", () => {
    const sessions = new ReverseProviderSessionRegistryV1(() => "incarnation-1");
    const session = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);
    operations.claim(session, operationOpen(session));

    expect(
      operations.observe(session, frame(session, "operation-1", { type: "dispatch-started" })),
    ).toMatchObject({ ok: true, released: false });
    const terminal = frame(session, "operation-1", {
      type: "terminal",
      outcome: "failed",
      certainty: "started-unconfirmed",
      failureCode: "connection-lost",
    });
    expect(operations.observe(session, terminal)).toMatchObject({ ok: true, released: true });
    expect(operations.observe(session, terminal)).toMatchObject({
      ok: false,
      code: "inactive-operation",
    });
  });

  it("drains only the detached incarnation and fences its late frames", () => {
    let sequence = 0;
    const sessions = new ReverseProviderSessionRegistryV1(() => `incarnation-${++sequence}`);
    const first = admit(sessions);
    const operations = new ReverseProviderOperationRegistryV1(sessions);
    operations.claim(first, operationOpen(first));
    sessions.detach(first.connectionId, first.incarnationId);

    expect(operations.drain(first)).toHaveLength(1);
    const second = admit(sessions);
    expect(operations.claim(second, operationOpen(second)).ok).toBe(true);
    expect(operations.drain(first)).toEqual([]);
    expect(operations.list(second)).toHaveLength(1);

    const lateFrame = frame(first, "operation-1", { type: "dispatch-started" });
    expect(operations.observe(first, lateFrame)).toMatchObject({
      ok: false,
      code: "stale-session",
    });
    expect(operations.observe(second, lateFrame)).toMatchObject({
      ok: false,
      code: "stale-session",
    });
  });
});
