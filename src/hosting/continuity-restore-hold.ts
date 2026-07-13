export const CONTINUITY_RESTORE_HOLD_VERSION = "continuity-restore-hold/v1" as const;

type ContinuityRestoreHoldBaseV1 = {
  version: typeof CONTINUITY_RESTORE_HOLD_VERSION;
  ownerId: string;
  ownerGeneration: string;
  revision: number;
};

export type ContinuityRestoreHoldStateV1 =
  | (ContinuityRestoreHoldBaseV1 & {
      phase: "runnable";
    })
  | (ContinuityRestoreHoldBaseV1 & {
      phase: "restore-held";
      restoreIdentity: string;
      publicationStarted: boolean;
    })
  | (ContinuityRestoreHoldBaseV1 & {
      phase: "restore-committed";
      restoreIdentity: string;
      receiptIdentity: string;
    })
  | (ContinuityRestoreHoldBaseV1 & {
      phase: "restore-quarantined";
      restoreIdentity: string;
    });

export type ContinuityRestoreHoldAuthorityV1 = {
  ownerId: string;
  ownerGeneration: string;
  expectedRevision: number;
};

export type ContinuityRestoreHoldFailureCode =
  | "authority-unavailable"
  | "owner-mismatch"
  | "stale-owner-generation"
  | "stale-revision"
  | "invalid-transition"
  | "restore-identity-mismatch"
  | "receipt-identity-mismatch"
  | "restore-held"
  | "restore-quarantined"
  | "restored-start-required"
  | "ordinary-start-required";

export class ContinuityRestoreHoldError extends Error {
  readonly code: ContinuityRestoreHoldFailureCode;

  constructor(code: ContinuityRestoreHoldFailureCode, message: string) {
    super(message);
    this.name = "ContinuityRestoreHoldError";
    this.code = code;
  }
}

function requireAuthority(
  current: ContinuityRestoreHoldStateV1 | undefined,
  authority: ContinuityRestoreHoldAuthorityV1,
): ContinuityRestoreHoldStateV1 {
  if (!current) {
    throw new ContinuityRestoreHoldError(
      "authority-unavailable",
      "Continuity lifecycle authority is unavailable",
    );
  }
  if (current.ownerId !== authority.ownerId) {
    throw new ContinuityRestoreHoldError(
      "owner-mismatch",
      "Continuity lifecycle owner does not match",
    );
  }
  if (current.ownerGeneration !== authority.ownerGeneration) {
    throw new ContinuityRestoreHoldError(
      "stale-owner-generation",
      "Continuity lifecycle owner generation is stale",
    );
  }
  if (current.revision !== authority.expectedRevision) {
    throw new ContinuityRestoreHoldError(
      "stale-revision",
      "Continuity lifecycle revision is stale",
    );
  }
  return current;
}

function requireRestoreIdentity(
  current: Extract<ContinuityRestoreHoldStateV1, { restoreIdentity: string }>,
  restoreIdentity: string,
): void {
  if (current.restoreIdentity !== restoreIdentity) {
    throw new ContinuityRestoreHoldError(
      "restore-identity-mismatch",
      "Continuity restore identity does not match",
    );
  }
}

function nextRunnable(
  current: ContinuityRestoreHoldStateV1,
): Extract<ContinuityRestoreHoldStateV1, { phase: "runnable" }> {
  return {
    version: CONTINUITY_RESTORE_HOLD_VERSION,
    phase: "runnable",
    ownerId: current.ownerId,
    ownerGeneration: current.ownerGeneration,
    revision: current.revision + 1,
  };
}

export function acquireContinuityRestoreHoldV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (current.phase !== "runnable") {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore hold can only be acquired from runnable",
    );
  }
  return {
    ...current,
    phase: "restore-held",
    revision: current.revision + 1,
    restoreIdentity: params.restoreIdentity,
    publicationStarted: false,
  };
}

export function markContinuityRestorePublicationStartedV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (current.phase !== "restore-held") {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore publication requires a restore hold",
    );
  }
  requireRestoreIdentity(current, params.restoreIdentity);
  return {
    ...current,
    revision: current.revision + 1,
    publicationStarted: true,
  };
}

export function cancelContinuityRestoreHoldV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (current.phase !== "restore-held") {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore cancellation requires a restore hold",
    );
  }
  requireRestoreIdentity(current, params.restoreIdentity);
  if (current.publicationStarted) {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore cannot be cancelled after publication starts",
    );
  }
  return nextRunnable(current);
}

export function commitContinuityRestoreHoldV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity: string;
  receiptIdentity: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (current.phase !== "restore-held" || !current.publicationStarted) {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore commit requires publication to have started",
    );
  }
  requireRestoreIdentity(current, params.restoreIdentity);
  return {
    version: CONTINUITY_RESTORE_HOLD_VERSION,
    phase: "restore-committed",
    ownerId: current.ownerId,
    ownerGeneration: current.ownerGeneration,
    revision: current.revision + 1,
    restoreIdentity: current.restoreIdentity,
    receiptIdentity: params.receiptIdentity,
  };
}

export function quarantineContinuityRestoreHoldV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (
    (current.phase !== "restore-held" || !current.publicationStarted) &&
    current.phase !== "restore-committed"
  ) {
    throw new ContinuityRestoreHoldError(
      "invalid-transition",
      "Continuity restore quarantine requires publication to have started",
    );
  }
  requireRestoreIdentity(current, params.restoreIdentity);
  return {
    version: CONTINUITY_RESTORE_HOLD_VERSION,
    phase: "restore-quarantined",
    ownerId: current.ownerId,
    ownerGeneration: current.ownerGeneration,
    revision: current.revision + 1,
    restoreIdentity: current.restoreIdentity,
  };
}

export function admitContinuityStartupV1(params: {
  current: ContinuityRestoreHoldStateV1 | undefined;
  authority: ContinuityRestoreHoldAuthorityV1;
  restoreIdentity?: string;
  receiptIdentity?: string;
}): ContinuityRestoreHoldStateV1 {
  const current = requireAuthority(params.current, params.authority);
  if (current.phase === "restore-held") {
    throw new ContinuityRestoreHoldError("restore-held", "Continuity restore is held");
  }
  if (current.phase === "restore-quarantined") {
    throw new ContinuityRestoreHoldError(
      "restore-quarantined",
      "Continuity restore is quarantined",
    );
  }
  if (current.phase === "runnable") {
    if (params.restoreIdentity !== undefined || params.receiptIdentity !== undefined) {
      throw new ContinuityRestoreHoldError(
        "ordinary-start-required",
        "Runnable continuity state requires an ordinary startup",
      );
    }
    return nextRunnable(current);
  }
  if (params.restoreIdentity === undefined || params.receiptIdentity === undefined) {
    throw new ContinuityRestoreHoldError(
      "restored-start-required",
      "Committed continuity state requires a restored startup",
    );
  }
  requireRestoreIdentity(current, params.restoreIdentity);
  if (current.receiptIdentity !== params.receiptIdentity) {
    throw new ContinuityRestoreHoldError(
      "receipt-identity-mismatch",
      "Continuity restore receipt identity does not match",
    );
  }
  return nextRunnable(current);
}
