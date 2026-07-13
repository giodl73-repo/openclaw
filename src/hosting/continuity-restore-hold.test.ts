import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTINUITY_RESTORE_HOLD_VERSION,
  ContinuityRestoreHoldError,
  acquireContinuityRestoreHoldV1,
  admitContinuityStartupV1,
  cancelContinuityRestoreHoldV1,
  commitContinuityRestoreHoldV1,
  markContinuityRestorePublicationStartedV1,
  quarantineContinuityRestoreHoldV1,
  type ContinuityRestoreHoldAuthorityV1,
  type ContinuityRestoreHoldStateV1,
} from "./continuity-restore-hold.js";

const runnable: ContinuityRestoreHoldStateV1 = {
  version: CONTINUITY_RESTORE_HOLD_VERSION,
  phase: "runnable",
  ownerId: "runtime-1",
  ownerGeneration: "owner-7",
  revision: 1,
};

function authority(current: ContinuityRestoreHoldStateV1): ContinuityRestoreHoldAuthorityV1 {
  return {
    ownerId: current.ownerId,
    ownerGeneration: current.ownerGeneration,
    expectedRevision: current.revision,
  };
}

describe("continuity restore hold", () => {
  it("fences restore publication through one matching restored startup", () => {
    const held = acquireContinuityRestoreHoldV1({
      current: runnable,
      authority: authority(runnable),
      restoreIdentity: "restore-12",
    });
    expect(() =>
      admitContinuityStartupV1({ current: held, authority: authority(held) }),
    ).toThrowError(expect.objectContaining({ code: "restore-held" }));

    const publishing = markContinuityRestorePublicationStartedV1({
      current: held,
      authority: authority(held),
      restoreIdentity: "restore-12",
    });
    const committed = commitContinuityRestoreHoldV1({
      current: publishing,
      authority: authority(publishing),
      restoreIdentity: "restore-12",
      receiptIdentity: "receipt-4",
    });
    expect(() =>
      admitContinuityStartupV1({ current: committed, authority: authority(committed) }),
    ).toThrowError(expect.objectContaining({ code: "restored-start-required" }));

    const consumed = admitContinuityStartupV1({
      current: committed,
      authority: authority(committed),
      restoreIdentity: "restore-12",
      receiptIdentity: "receipt-4",
    });
    expect(consumed).toEqual({
      version: CONTINUITY_RESTORE_HOLD_VERSION,
      phase: "runnable",
      ownerId: "runtime-1",
      ownerGeneration: "owner-7",
      revision: 5,
    });
    expect(() =>
      admitContinuityStartupV1({
        current: consumed,
        authority: authority(consumed),
        restoreIdentity: "restore-12",
        receiptIdentity: "receipt-4",
      }),
    ).toThrowError(expect.objectContaining({ code: "ordinary-start-required" }));
  });

  it("allows cancellation only before publication and otherwise quarantines", () => {
    const held = acquireContinuityRestoreHoldV1({
      current: runnable,
      authority: authority(runnable),
      restoreIdentity: "restore-12",
    });
    expect(
      cancelContinuityRestoreHoldV1({
        current: held,
        authority: authority(held),
        restoreIdentity: "restore-12",
      }),
    ).toMatchObject({ phase: "runnable", revision: 3 });

    const publishing = markContinuityRestorePublicationStartedV1({
      current: held,
      authority: authority(held),
      restoreIdentity: "restore-12",
    });
    expect(() =>
      cancelContinuityRestoreHoldV1({
        current: publishing,
        authority: authority(publishing),
        restoreIdentity: "restore-12",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-transition" }));
    expect(
      quarantineContinuityRestoreHoldV1({
        current: publishing,
        authority: authority(publishing),
        restoreIdentity: "restore-12",
      }),
    ).toMatchObject({
      phase: "restore-quarantined",
      restoreIdentity: "restore-12",
      revision: 4,
    });
  });

  it("fails closed on unknown authority and stale or mismatched identities", () => {
    expect(() =>
      acquireContinuityRestoreHoldV1({
        current: undefined,
        authority: authority(runnable),
        restoreIdentity: "restore-12",
      }),
    ).toThrowError(expect.objectContaining({ code: "authority-unavailable" }));
    expect(() =>
      acquireContinuityRestoreHoldV1({
        current: runnable,
        authority: { ...authority(runnable), ownerGeneration: "owner-6" },
        restoreIdentity: "restore-12",
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-owner-generation" }));
    expect(() =>
      acquireContinuityRestoreHoldV1({
        current: runnable,
        authority: { ...authority(runnable), expectedRevision: 0 },
        restoreIdentity: "restore-12",
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-revision" }));

    const held = acquireContinuityRestoreHoldV1({
      current: runnable,
      authority: authority(runnable),
      restoreIdentity: "restore-12",
    });
    expect(() =>
      markContinuityRestorePublicationStartedV1({
        current: held,
        authority: authority(held),
        restoreIdentity: "restore-13",
      }),
    ).toThrowError(expect.objectContaining({ code: "restore-identity-mismatch" }));
  });

  it("keeps the portable conformance fixture aligned with the contract", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../test/fixtures/continuity-restore-hold-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      version: string;
      phases: string[];
      failureCodes: string[];
    };

    expect(fixture.version).toBe(CONTINUITY_RESTORE_HOLD_VERSION);
    expect(fixture.phases).toEqual([
      "runnable",
      "restore-held",
      "restore-committed",
      "restore-quarantined",
    ]);
    for (const code of [
      "authority-unavailable",
      "stale-owner-generation",
      "stale-revision",
      "restore-identity-mismatch",
      "receipt-identity-mismatch",
      "restore-held",
      "restore-quarantined",
    ]) {
      expect(fixture.failureCodes).toContain(code);
    }
    expect(ContinuityRestoreHoldError).toBeTypeOf("function");
  });
});
