import {
  assertReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchFrameV1,
} from "./reverse-provider-dispatch.js";
import {
  ReverseProviderSessionRegistryV1,
  type ReverseProviderSessionV1,
} from "./reverse-provider-session.js";

export const REVERSE_PROVIDER_MAX_ACTIVE_OPERATIONS_V1 = 64;

export type ReverseProviderOperationOwnershipV1 = {
  operationId: string;
  bindingId: string;
  connectionId: string;
  incarnationId: string;
  ownerGeneration: string;
  hostBundleGeneration: string;
};

export type ReverseProviderOperationClaimResultV1 =
  | { ok: true; operation: Readonly<ReverseProviderOperationOwnershipV1> }
  | {
      ok: false;
      code: "malformed" | "stale-session" | "duplicate-operation" | "capacity-exceeded";
      message: string;
    };

export type ReverseProviderOperationFrameResultV1 =
  | {
      ok: true;
      operation: Readonly<ReverseProviderOperationOwnershipV1>;
      released: boolean;
    }
  | {
      ok: false;
      code: "malformed" | "stale-session" | "inactive-operation";
      message: string;
    };

type SessionOperations = {
  session: Readonly<ReverseProviderSessionV1>;
  operations: Map<string, Readonly<ReverseProviderOperationOwnershipV1>>;
};

function parseFrame(
  value: unknown,
): { ok: true; frame: ReverseProviderDispatchFrameV1 } | { ok: false; message: string } {
  try {
    return { ok: true, frame: assertReverseProviderDispatchFrameV1(value) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "malformed reverse-provider frame",
    };
  }
}

function frameMatchesSession(
  frame: ReverseProviderDispatchFrameV1,
  session: Readonly<ReverseProviderSessionV1>,
): boolean {
  return (
    frame.incarnationId === session.incarnationId &&
    frame.ownerGeneration === session.declaration.ownerGeneration &&
    frame.hostBundleGeneration === session.declaration.hostBundleGeneration &&
    (frame.type !== "operation-open" || frame.bindingId === session.declaration.bindingId)
  );
}

/** Process-local operation ownership for admitted reverse-provider sessions. */
export class ReverseProviderOperationRegistryV1 {
  readonly #byIncarnation = new Map<string, SessionOperations>();
  readonly #sessions: ReverseProviderSessionRegistryV1;
  readonly #maxActive: number;
  #size = 0;

  constructor(
    sessions: ReverseProviderSessionRegistryV1,
    maxActive = REVERSE_PROVIDER_MAX_ACTIVE_OPERATIONS_V1,
  ) {
    if (!Number.isSafeInteger(maxActive) || maxActive <= 0) {
      throw new Error("maxActive must be a positive safe integer");
    }
    this.#sessions = sessions;
    this.#maxActive = maxActive;
  }

  claim(
    session: Readonly<ReverseProviderSessionV1>,
    frameValue: unknown,
  ): ReverseProviderOperationClaimResultV1 {
    if (!this.#sessions.isCurrent(session)) {
      return { ok: false, code: "stale-session", message: "session is not current" };
    }
    const parsed = parseFrame(frameValue);
    if (!parsed.ok) {
      return { ok: false, code: "malformed", message: parsed.message };
    }
    const frame = parsed.frame;
    if (frame.type !== "operation-open") {
      return {
        ok: false,
        code: "malformed",
        message: "operation ownership must be claimed with an operation-open frame",
      };
    }
    if (!frameMatchesSession(frame, session)) {
      return {
        ok: false,
        code: "stale-session",
        message: "operation-open does not match the current session",
      };
    }

    const bucket = this.#byIncarnation.get(session.incarnationId);
    if (bucket && bucket.session !== session) {
      return {
        ok: false,
        code: "stale-session",
        message: "session incarnation belongs to a different admission",
      };
    }
    if (bucket?.operations.has(frame.operationId)) {
      return {
        ok: false,
        code: "duplicate-operation",
        message: "operation is already active for this session",
      };
    }
    if (this.#size >= this.#maxActive) {
      return {
        ok: false,
        code: "capacity-exceeded",
        message: "active operation capacity exceeded",
      };
    }

    const ownership = Object.freeze({
      operationId: frame.operationId,
      bindingId: session.declaration.bindingId,
      connectionId: session.connectionId,
      incarnationId: session.incarnationId,
      ownerGeneration: session.declaration.ownerGeneration,
      hostBundleGeneration: session.declaration.hostBundleGeneration,
    });
    const operations = bucket?.operations ?? new Map();
    operations.set(frame.operationId, ownership);
    if (!bucket) {
      this.#byIncarnation.set(session.incarnationId, { session, operations });
    }
    this.#size += 1;
    return { ok: true, operation: ownership };
  }

  observe(
    session: Readonly<ReverseProviderSessionV1>,
    frameValue: unknown,
  ): ReverseProviderOperationFrameResultV1 {
    if (!this.#sessions.isCurrent(session)) {
      return { ok: false, code: "stale-session", message: "session is not current" };
    }
    const parsed = parseFrame(frameValue);
    if (!parsed.ok) {
      return { ok: false, code: "malformed", message: parsed.message };
    }
    const frame = parsed.frame;
    if (frame.type === "operation-open") {
      return {
        ok: false,
        code: "malformed",
        message: "operation-open frames must claim ownership",
      };
    }
    if (!frameMatchesSession(frame, session)) {
      return {
        ok: false,
        code: "stale-session",
        message: "frame does not match the current session",
      };
    }

    const bucket = this.#byIncarnation.get(session.incarnationId);
    const ownership = bucket?.operations.get(frame.operationId);
    if (!ownership || bucket?.session !== session) {
      return {
        ok: false,
        code: "inactive-operation",
        message: "operation is not active for this session",
      };
    }
    if (frame.type === "terminal") {
      bucket.operations.delete(frame.operationId);
      this.#size -= 1;
      if (bucket.operations.size === 0) {
        this.#byIncarnation.delete(session.incarnationId);
      }
      return { ok: true, operation: ownership, released: true };
    }
    return { ok: true, operation: ownership, released: false };
  }

  list(
    session: Readonly<ReverseProviderSessionV1>,
  ): readonly Readonly<ReverseProviderOperationOwnershipV1>[] {
    const bucket = this.#byIncarnation.get(session.incarnationId);
    if (!bucket || bucket.session !== session) {
      return Object.freeze([]);
    }
    return Object.freeze([...bucket.operations.values()]);
  }

  drain(
    session: Readonly<ReverseProviderSessionV1>,
  ): readonly Readonly<ReverseProviderOperationOwnershipV1>[] {
    const bucket = this.#byIncarnation.get(session.incarnationId);
    if (!bucket || bucket.session !== session) {
      return Object.freeze([]);
    }
    this.#byIncarnation.delete(session.incarnationId);
    this.#size -= bucket.operations.size;
    return Object.freeze([...bucket.operations.values()]);
  }
}
