import { describe, expect, it } from "vitest";
import { OPENCLAW_LOCALES } from "../../packages/localization-core/src/locale-registry.js";
import {
  COMPLEX_SCRIPT_PROFILES,
  evaluateLocalizationReleaseReadiness,
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
    docs: { status: "supported" },
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

  it("keeps complex-script profiles aligned with locale direction", () => {
    expect(COMPLEX_SCRIPT_PROFILES).toEqual({
      hi: { script: "devanagari", direction: "ltr" },
      ar: { script: "arabic", direction: "rtl" },
      th: { script: "thai", direction: "ltr" },
      fa: { script: "arabic-derived", direction: "rtl" },
    });
  });

  it("publishes only a qualified claim while coverage cells remain incomplete", () => {
    const releaseLocales = OPENCLAW_LOCALES.filter((locale) => locale !== "en");
    expect(
      evaluateLocalizationReleaseReadiness({
        surfaces: {
          ui: {
            locales: Object.fromEntries(
              releaseLocales.map((locale) => [
                locale,
                { maturity: locale === "fa" ? "platform-constrained" : "partial" },
              ]),
            ),
          },
        },
      }),
    ).toMatchObject({
      status: "qualified-maturity-only",
      unqualifiedFullProductClaim: false,
      openClawOwnedLocalizationComplete: false,
      platformConstraints: [{ locale: "fa", surface: "ui" }],
    });
  });

  it("distinguishes full localization from owned completion with platform constraints", () => {
    const releaseLocales = OPENCLAW_LOCALES.filter((locale) => locale !== "en");
    const complete = Object.fromEntries(
      releaseLocales.map((locale) => [locale, { maturity: "complete" }]),
    );
    expect(
      evaluateLocalizationReleaseReadiness({ surfaces: { ui: { locales: complete } } }),
    ).toMatchObject({
      status: "fully-localized",
      unqualifiedFullProductClaim: true,
      openClawOwnedLocalizationComplete: true,
    });

    const constrained = {
      ...complete,
      fa: { maturity: "platform-constrained" },
    };
    expect(
      evaluateLocalizationReleaseReadiness({ surfaces: { ui: { locales: constrained } } }),
    ).toMatchObject({
      status: "openclaw-owned-complete-with-platform-constraints",
      unqualifiedFullProductClaim: false,
      openClawOwnedLocalizationComplete: true,
    });
  });

  it("fails closed when the coverage surface inventory is empty", () => {
    expect(() => evaluateLocalizationReleaseReadiness({ surfaces: {} })).toThrow(
      "localization release readiness requires at least one coverage surface",
    );
  });
});
