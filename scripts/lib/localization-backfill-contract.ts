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

export const LOCALIZATION_BACKFILL_BLOCKERS = [
  "control-ui-unsupported",
  "control-ui-fallback",
  "cli-onboarding-unsupported",
  "cli-unsupported",
  "tui-unsupported",
  "docs-unsupported",
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
  docs: { supported: boolean };
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
  return issues;
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
  if (!evidence.docs.supported) {
    blockers.push("docs-unsupported");
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
