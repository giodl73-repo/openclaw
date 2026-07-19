import {
  getLocaleDirection,
  OPENCLAW_LOCALES,
  type OpenClawLocale,
} from "../../packages/localization-core/src/locale-registry.js";

export const SIMPLER_SCRIPT_LOCALES = [
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "vi",
  "nl",
  "ru",
  "sv",
] as const satisfies readonly OpenClawLocale[];

export const COMPLEX_SCRIPT_LOCALES = [
  "hi",
  "ar",
  "th",
  "fa",
] as const satisfies readonly OpenClawLocale[];

export const COMPLEX_SCRIPT_PROFILES = {
  hi: { script: "devanagari", direction: "ltr" },
  ar: { script: "arabic", direction: "rtl" },
  th: { script: "thai", direction: "ltr" },
  fa: { script: "arabic-derived", direction: "rtl" },
} as const satisfies Record<
  (typeof COMPLEX_SCRIPT_LOCALES)[number],
  { script: string; direction: "ltr" | "rtl" }
>;

export const LOCALIZATION_BACKFILL_BLOCKERS = [
  "control-ui-unsupported",
  "control-ui-fallback",
  "cli-onboarding-unsupported",
  "cli-unsupported",
  "tui-unsupported",
  "docs-unsupported",
  "docs-platform-constrained",
  "native-artifact-missing",
  "native-quality-advisories",
  "human-review-pending",
] as const;

export type LocalizationBackfillBlocker = (typeof LOCALIZATION_BACKFILL_BLOCKERS)[number];

export type BackfillLocaleEvidence = {
  controlUi: { supported: boolean; fallbackCount: number };
  cliOnboarding: { supported: boolean };
  cli: { supported: boolean };
  tui: { supported: boolean };
  docs: { status: "supported" | "platform-constrained" | "unsupported" };
  native: {
    sharedArtifact: boolean;
    androidArtifact: boolean;
    appleArtifact: boolean;
    qualityAdvisories: number;
  };
  review: { status: "pending" | "reviewed"; languageOwner?: string };
};

export type BackfillLocaleState = BackfillLocaleEvidence & {
  blockers: readonly LocalizationBackfillBlocker[];
  promotionEligible: boolean;
};

export function validateBackfillLocalePartition(): string[] {
  const expected = OPENCLAW_LOCALES.filter((locale) => locale !== "en");
  const actual = [...SIMPLER_SCRIPT_LOCALES, ...COMPLEX_SCRIPT_LOCALES];
  const issues: string[] = [];
  if (new Set(actual).size !== actual.length) {
    issues.push("backfill locale sets overlap");
  }
  if (actual.toSorted().join("\u0000") !== expected.toSorted().join("\u0000")) {
    issues.push("backfill locale sets do not partition every registered translation target");
  }
  for (const locale of SIMPLER_SCRIPT_LOCALES) {
    if (getLocaleDirection(locale) !== "ltr") {
      issues.push(`simpler-script locale ${locale} must be left-to-right`);
    }
  }
  for (const locale of COMPLEX_SCRIPT_LOCALES) {
    const profile = COMPLEX_SCRIPT_PROFILES[locale];
    if (getLocaleDirection(locale) !== profile.direction) {
      issues.push(`complex-script locale ${locale} must be ${profile.direction}`);
    }
  }
  return issues;
}

export type LocalizationReleaseReadiness = {
  status:
    | "fully-localized"
    | "openclaw-owned-complete-with-platform-constraints"
    | "qualified-maturity-only";
  unqualifiedFullProductClaim: boolean;
  openClawOwnedLocalizationComplete: boolean;
  localeCount: number;
  surfaceCount: number;
  platformConstraints: readonly { locale: string; surface: string }[];
  locales: Readonly<
    Record<
      string,
      {
        blockingSurfaces: readonly string[];
        completeSurfaces: readonly string[];
        platformConstrainedSurfaces: readonly string[];
      }
    >
  >;
};

export function evaluateLocalizationReleaseReadiness(manifest: {
  surfaces: Readonly<Record<string, { locales: Readonly<Record<string, { maturity: string }>> }>>;
}): LocalizationReleaseReadiness {
  const releaseLocales = OPENCLAW_LOCALES.filter((locale) => locale !== "en");
  const surfaceEntries = Object.entries(manifest.surfaces);
  if (surfaceEntries.length === 0) {
    throw new Error("localization release readiness requires at least one coverage surface");
  }
  const platformConstraints: { locale: string; surface: string }[] = [];
  const locales = Object.fromEntries(
    releaseLocales.map((locale) => {
      const completeSurfaces: string[] = [];
      const platformConstrainedSurfaces: string[] = [];
      const blockingSurfaces: string[] = [];
      for (const [surface, definition] of surfaceEntries) {
        const maturity = definition.locales[locale]?.maturity;
        if (maturity === "complete") {
          completeSurfaces.push(surface);
        } else if (maturity === "platform-constrained") {
          platformConstrainedSurfaces.push(surface);
          platformConstraints.push({ locale, surface });
        } else {
          blockingSurfaces.push(surface);
        }
      }
      return [
        locale,
        {
          blockingSurfaces: Object.freeze(blockingSurfaces),
          completeSurfaces: Object.freeze(completeSurfaces),
          platformConstrainedSurfaces: Object.freeze(platformConstrainedSurfaces),
        },
      ];
    }),
  );
  const localeStates = Object.values(locales);
  const unqualifiedFullProductClaim = localeStates.every(
    (state) =>
      state.blockingSurfaces.length === 0 && state.platformConstrainedSurfaces.length === 0,
  );
  const openClawOwnedLocalizationComplete = localeStates.every(
    (state) => state.blockingSurfaces.length === 0,
  );
  return {
    status: unqualifiedFullProductClaim
      ? "fully-localized"
      : openClawOwnedLocalizationComplete
        ? "openclaw-owned-complete-with-platform-constraints"
        : "qualified-maturity-only",
    unqualifiedFullProductClaim,
    openClawOwnedLocalizationComplete,
    localeCount: releaseLocales.length,
    surfaceCount: surfaceEntries.length,
    platformConstraints: Object.freeze(platformConstraints),
    locales: Object.freeze(locales),
  };
}

export function evaluateBackfillLocale(evidence: BackfillLocaleEvidence): BackfillLocaleState {
  const blockers: LocalizationBackfillBlocker[] = [];
  if (!evidence.controlUi.supported) {
    blockers.push("control-ui-unsupported");
  } else if (evidence.controlUi.fallbackCount > 0) {
    blockers.push("control-ui-fallback");
  }
  if (!evidence.cliOnboarding.supported) {
    blockers.push("cli-onboarding-unsupported");
  }
  if (!evidence.cli.supported) {
    blockers.push("cli-unsupported");
  }
  if (!evidence.tui.supported) {
    blockers.push("tui-unsupported");
  }
  if (evidence.docs.status === "unsupported") {
    blockers.push("docs-unsupported");
  } else if (evidence.docs.status === "platform-constrained") {
    blockers.push("docs-platform-constrained");
  }
  if (
    !evidence.native.sharedArtifact ||
    !evidence.native.androidArtifact ||
    !evidence.native.appleArtifact
  ) {
    blockers.push("native-artifact-missing");
  }
  if (evidence.native.qualityAdvisories > 0) {
    blockers.push("native-quality-advisories");
  }
  if (evidence.review.status !== "reviewed" || !evidence.review.languageOwner?.trim()) {
    blockers.push("human-review-pending");
  }
  return {
    ...evidence,
    blockers: Object.freeze(blockers),
    promotionEligible: blockers.length === 0,
  };
}
