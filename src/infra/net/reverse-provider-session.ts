import { randomUUID } from "node:crypto";
import { REVERSE_PROVIDER_DISPATCH_VERSION } from "./reverse-provider-dispatch.js";

export const REVERSE_PROVIDER_SESSION_VERSION = "reverse-provider-session/v1" as const;
export const PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION =
  "provider-request-dispatcher/v1" as const;

export type ReverseProviderSessionDeclarationV1 = {
  version: typeof REVERSE_PROVIDER_SESSION_VERSION;
  bindingId: string;
  interfaceVersion: string;
  carrierVersion: typeof REVERSE_PROVIDER_DISPATCH_VERSION;
  ownerGeneration: string;
  hostBundleGeneration: string;
};

export type ReverseProviderVerifiedPeerV1 = {
  credentialId: string;
  keyFingerprint: string;
  audience: string;
  expiresAtMs: number;
};

export type ReverseProviderSessionAuthorityV1 = {
  bindingId: string;
  interfaceVersion: string;
  carrierVersion: typeof REVERSE_PROVIDER_DISPATCH_VERSION;
  ownerGeneration: string;
  hostBundleGeneration: string;
  audience: string;
  keyFingerprint: string;
};

export type ReverseProviderSessionV1 = {
  version: typeof REVERSE_PROVIDER_SESSION_VERSION;
  incarnationId: string;
  connectionId: string;
  admittedAtMs: number;
  declaration: Readonly<ReverseProviderSessionDeclarationV1>;
  verifiedPeer: Readonly<ReverseProviderVerifiedPeerV1>;
};

export type ReverseProviderSessionAdmissionResultV1 =
  | { ok: true; session: Readonly<ReverseProviderSessionV1> }
  | {
      ok: false;
      code:
        | "malformed"
        | "expired"
        | "stale-authority"
        | "duplicate-binding"
        | "duplicate-connection";
      message: string;
    };

type ReverseProviderSessionCandidateV1 = {
  declaration: ReverseProviderSessionDeclarationV1;
  connectionId: string;
  verifiedPeer: ReverseProviderVerifiedPeerV1;
};

const MAX_STRING_LENGTH = 512;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  const expectedSet = new Set(expected);
  const unknown = actual.find((key) => !expectedSet.has(key));
  const missing = expected.find((key) => !(key in record));
  if (unknown) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
  if (missing) {
    throw new Error(`${label} is missing field ${missing}`);
  }
}

function requireBoundedString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label}.${key} must be a non-empty bounded string`);
  }
  return value;
}

function requireSafeTimestamp(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label}.${key} must be a positive safe integer`);
  }
  return value as number;
}

function requireNow(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("nowMs must be a non-negative safe integer");
  }
  return value as number;
}

function parseDeclaration(value: unknown): ReverseProviderSessionDeclarationV1 {
  const record = assertRecord(value, "declaration");
  assertExactKeys(
    record,
    [
      "version",
      "bindingId",
      "interfaceVersion",
      "carrierVersion",
      "ownerGeneration",
      "hostBundleGeneration",
    ],
    "declaration",
  );
  if (record.version !== REVERSE_PROVIDER_SESSION_VERSION) {
    throw new Error(`declaration.version must be ${REVERSE_PROVIDER_SESSION_VERSION}`);
  }
  if (record.interfaceVersion !== PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION) {
    throw new Error(
      `declaration.interfaceVersion must be ${PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION}`,
    );
  }
  if (record.carrierVersion !== REVERSE_PROVIDER_DISPATCH_VERSION) {
    throw new Error(`declaration.carrierVersion must be ${REVERSE_PROVIDER_DISPATCH_VERSION}`);
  }
  return {
    version: REVERSE_PROVIDER_SESSION_VERSION,
    bindingId: requireBoundedString(record, "bindingId", "declaration"),
    interfaceVersion: requireBoundedString(record, "interfaceVersion", "declaration"),
    carrierVersion: REVERSE_PROVIDER_DISPATCH_VERSION,
    ownerGeneration: requireBoundedString(record, "ownerGeneration", "declaration"),
    hostBundleGeneration: requireBoundedString(record, "hostBundleGeneration", "declaration"),
  };
}

function parseVerifiedPeer(value: unknown): ReverseProviderVerifiedPeerV1 {
  const record = assertRecord(value, "verifiedPeer");
  assertExactKeys(
    record,
    ["credentialId", "keyFingerprint", "audience", "expiresAtMs"],
    "verifiedPeer",
  );
  return {
    credentialId: requireBoundedString(record, "credentialId", "verifiedPeer"),
    keyFingerprint: requireBoundedString(record, "keyFingerprint", "verifiedPeer"),
    audience: requireBoundedString(record, "audience", "verifiedPeer"),
    expiresAtMs: requireSafeTimestamp(record, "expiresAtMs", "verifiedPeer"),
  };
}

function parseAuthority(value: unknown): ReverseProviderSessionAuthorityV1 {
  const record = assertRecord(value, "expectedAuthority");
  assertExactKeys(
    record,
    [
      "bindingId",
      "interfaceVersion",
      "carrierVersion",
      "ownerGeneration",
      "hostBundleGeneration",
      "audience",
      "keyFingerprint",
    ],
    "expectedAuthority",
  );
  if (record.interfaceVersion !== PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION) {
    throw new Error(
      `expectedAuthority.interfaceVersion must be ${PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION}`,
    );
  }
  if (record.carrierVersion !== REVERSE_PROVIDER_DISPATCH_VERSION) {
    throw new Error(
      `expectedAuthority.carrierVersion must be ${REVERSE_PROVIDER_DISPATCH_VERSION}`,
    );
  }
  return {
    bindingId: requireBoundedString(record, "bindingId", "expectedAuthority"),
    interfaceVersion: requireBoundedString(record, "interfaceVersion", "expectedAuthority"),
    carrierVersion: REVERSE_PROVIDER_DISPATCH_VERSION,
    ownerGeneration: requireBoundedString(record, "ownerGeneration", "expectedAuthority"),
    hostBundleGeneration: requireBoundedString(record, "hostBundleGeneration", "expectedAuthority"),
    audience: requireBoundedString(record, "audience", "expectedAuthority"),
    keyFingerprint: requireBoundedString(record, "keyFingerprint", "expectedAuthority"),
  };
}

function parseCandidate(value: unknown): ReverseProviderSessionCandidateV1 {
  const record = assertRecord(value, "candidate");
  assertExactKeys(record, ["declaration", "connectionId", "verifiedPeer"], "candidate");
  return {
    declaration: parseDeclaration(record.declaration),
    connectionId: requireBoundedString(record, "connectionId", "candidate"),
    verifiedPeer: parseVerifiedPeer(record.verifiedPeer),
  };
}

function authorityMatches(
  declaration: ReverseProviderSessionDeclarationV1,
  peer: ReverseProviderVerifiedPeerV1,
  authority: ReverseProviderSessionAuthorityV1,
): boolean {
  return (
    declaration.bindingId === authority.bindingId &&
    declaration.interfaceVersion === authority.interfaceVersion &&
    declaration.carrierVersion === authority.carrierVersion &&
    declaration.ownerGeneration === authority.ownerGeneration &&
    declaration.hostBundleGeneration === authority.hostBundleGeneration &&
    peer.audience === authority.audience &&
    peer.keyFingerprint === authority.keyFingerprint
  );
}

function freezeSession(
  candidate: ReverseProviderSessionCandidateV1,
  incarnationId: string,
  admittedAtMs: number,
): Readonly<ReverseProviderSessionV1> {
  return Object.freeze({
    version: REVERSE_PROVIDER_SESSION_VERSION,
    incarnationId,
    connectionId: candidate.connectionId,
    admittedAtMs,
    declaration: Object.freeze({ ...candidate.declaration }),
    verifiedPeer: Object.freeze({ ...candidate.verifiedPeer }),
  });
}

/** Process-local ownership for already authenticated reverse-provider connections. */
export class ReverseProviderSessionRegistryV1 {
  readonly #byBinding = new Map<string, Readonly<ReverseProviderSessionV1>>();
  readonly #byConnection = new Map<string, Readonly<ReverseProviderSessionV1>>();
  readonly #createIncarnationId: () => string;
  readonly #nowMs: () => number;
  #incarnationSequence = 0n;

  constructor(createIncarnationId: () => string = randomUUID, nowMs: () => number = Date.now) {
    this.#createIncarnationId = createIncarnationId;
    this.#nowMs = nowMs;
  }

  /**
   * Admits evidence produced by the connection owner's credential verifier.
   * This registry records that proof but deliberately does not parse or authenticate credentials.
   */
  admit(
    candidateValue: unknown,
    expectedAuthorityValue: unknown,
    nowValue: unknown = this.#nowMs(),
  ): ReverseProviderSessionAdmissionResultV1 {
    let candidate: ReverseProviderSessionCandidateV1;
    let authority: ReverseProviderSessionAuthorityV1;
    let nowMs: number;
    try {
      candidate = parseCandidate(candidateValue);
      authority = parseAuthority(expectedAuthorityValue);
      nowMs = requireNow(nowValue);
    } catch (error) {
      return {
        ok: false,
        code: "malformed",
        message: error instanceof Error ? error.message : "malformed session candidate",
      };
    }

    if (candidate.verifiedPeer.expiresAtMs <= nowMs) {
      return { ok: false, code: "expired", message: "verified peer proof has expired" };
    }
    if (!authorityMatches(candidate.declaration, candidate.verifiedPeer, authority)) {
      return {
        ok: false,
        code: "stale-authority",
        message: "session declaration does not match the current binding authority",
      };
    }
    if (this.#byBinding.has(candidate.declaration.bindingId)) {
      return {
        ok: false,
        code: "duplicate-binding",
        message: "binding already has an admitted session",
      };
    }
    if (this.#byConnection.has(candidate.connectionId)) {
      return {
        ok: false,
        code: "duplicate-connection",
        message: "connection already has an admitted session",
      };
    }

    let incarnationSeed: string;
    try {
      incarnationSeed = this.#createIncarnationId();
    } catch {
      return {
        ok: false,
        code: "malformed",
        message: "incarnation id factory failed",
      };
    }
    if (
      typeof incarnationSeed !== "string" ||
      incarnationSeed.length === 0 ||
      incarnationSeed.length > MAX_STRING_LENGTH - 32
    ) {
      return {
        ok: false,
        code: "malformed",
        message: "incarnation id factory returned an invalid identifier",
      };
    }
    // The monotonic suffix prevents a late close from matching a later session even
    // if an injected entropy source repeats, without retaining an unbounded ID set.
    this.#incarnationSequence += 1n;
    const incarnationId = `${incarnationSeed}:${this.#incarnationSequence}`;
    const session = freezeSession(candidate, incarnationId, nowMs);
    this.#byBinding.set(candidate.declaration.bindingId, session);
    this.#byConnection.set(candidate.connectionId, session);
    return { ok: true, session };
  }

  getByBinding(bindingId: string): Readonly<ReverseProviderSessionV1> | undefined {
    return this.#byBinding.get(bindingId);
  }

  isCurrent(session: Readonly<ReverseProviderSessionV1>): boolean {
    let nowMs: number;
    try {
      nowMs = requireNow(this.#nowMs());
    } catch {
      return false;
    }
    return (
      session.verifiedPeer.expiresAtMs > nowMs &&
      this.#byBinding.get(session.declaration.bindingId) === session &&
      this.#byConnection.get(session.connectionId) === session
    );
  }

  list(): readonly Readonly<ReverseProviderSessionV1>[] {
    return Object.freeze([...this.#byBinding.values()]);
  }

  detach(
    connectionId: string,
    incarnationId: string,
  ): Readonly<ReverseProviderSessionV1> | undefined {
    const session = this.#byConnection.get(connectionId);
    if (!session || session.incarnationId !== incarnationId) {
      return undefined;
    }
    this.#byConnection.delete(connectionId);
    this.#byBinding.delete(session.declaration.bindingId);
    return session;
  }

  expire(nowValue: unknown = this.#nowMs()): readonly Readonly<ReverseProviderSessionV1>[] {
    const nowMs = requireNow(nowValue);
    const expired: Readonly<ReverseProviderSessionV1>[] = [];
    for (const session of this.#byBinding.values()) {
      if (session.verifiedPeer.expiresAtMs <= nowMs) {
        this.#byBinding.delete(session.declaration.bindingId);
        this.#byConnection.delete(session.connectionId);
        expired.push(session);
      }
    }
    return Object.freeze(expired);
  }
}
