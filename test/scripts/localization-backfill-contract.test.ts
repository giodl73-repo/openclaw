import { describe, expect, it } from "vitest";
import {
  evaluateBackfillLocale,
  validateBackfillLocalePartition,
  type BackfillLocaleEvidence,
} from "../../scripts/lib/localization-backfill-contract.js";

function completeEvidence(): BackfillLocaleEvidence {
  return {
    controlUi: { supported: true, fallbackCount: 0 },
    cliOnboarding: { supported: true },
    cli: { supported: true },
    tui: { supported: true },
    docs: { supported: true },
    native: {
      sharedArtifact: true,
      androidArtifact: true,
      appleArtifact: true,
      qualityAdvisories: 0,
    },
    review: { status: "reviewed", languageOwner: "test-language-owner" },
  };
}

describe("localization backfill contract", () => {
  it("partitions every registered translation target", () => {
    expect(validateBackfillLocalePartition()).toEqual([]);
  });

  it("promotes only fully supported and reviewed evidence", () => {
    expect(evaluateBackfillLocale(completeEvidence())).toMatchObject({
      blockers: [],
      promotionEligible: true,
    });
  });

  it("keeps untranslated and unreviewed catalogs blocked", () => {
    expect(
      evaluateBackfillLocale({
        ...completeEvidence(),
        controlUi: { supported: true, fallbackCount: 1 },
        native: {
          sharedArtifact: true,
          androidArtifact: false,
          appleArtifact: true,
          qualityAdvisories: 2,
        },
        review: { status: "pending" },
      }),
    ).toMatchObject({
      blockers: [
        "control-ui-fallback",
        "native-artifact-missing",
        "native-quality-advisories",
        "human-review-pending",
      ],
      promotionEligible: false,
    });
  });
});
