import fs from "node:fs";
import path from "node:path";
import { CLI_SUPPORTED_LOCALES } from "../src/cli/i18n/runtime.js";
import { TUI_SUPPORTED_LOCALES } from "../src/tui/i18n/runtime.js";
import { WIZARD_LOCALES } from "../src/wizard/i18n/index.js";
import { SUPPORTED_LOCALES as CONTROL_UI_LOCALES } from "../ui/src/i18n/lib/registry.js";
import { getAndroidLocaleDirectory } from "./android-app-i18n.js";
import { APPLE_I18N_LOCALES } from "./apple-app-i18n.js";
import { GENERATED_LOCALES } from "./lib/docs-i18n-locales.mjs";
import {
  COMPLEX_SCRIPT_LOCALES,
  COMPLEX_SCRIPT_PROFILES,
  evaluateLocalizationReleaseReadiness,
  evaluateBackfillLocale,
  SIMPLER_SCRIPT_LOCALES,
  validateBackfillLocalePartition,
  type BackfillLocaleEvidence,
  type BackfillLocaleState,
} from "./lib/localization-backfill-contract.js";
import { DOCS_PLATFORM_CONSTRAINED_LOCALES } from "./lib/localization-surface-convergence.js";
import {
  checkNativeLocaleArtifacts,
  collectNativeI18nEntries,
  NATIVE_I18N_LOCALES,
} from "./native-app-i18n.js";

type FallbackBaseline = {
  fallbacks: Record<string, string[]>;
};

type ReviewManifest = {
  version: 1;
  locales: Record<string, BackfillLocaleEvidence["review"]>;
};

type AppleCatalog = {
  strings?: Record<
    string,
    {
      localizations?: Record<string, { stringUnit?: { value?: string } }>;
    }
  >;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const localizationDir = path.join(ROOT, "localization");
const simpleOutputPath = path.join(localizationDir, "simple-script-backfill.json");
const complexOutputPath = path.join(localizationDir, "complex-script-backfill.json");
const releaseOutputPath = path.join(localizationDir, "release-readiness.json");
const coveragePath = path.join(localizationDir, "coverage.json");
const fallbackBaselinePath = path.join(
  ROOT,
  "ui",
  "src",
  "i18n",
  ".i18n",
  "catalog-fallbacks.json",
);
const write = process.argv.includes("--write");
const supportsLocale = (supportedLocales: readonly string[], locale: string): boolean =>
  supportedLocales.includes(locale);

const partitionIssues = validateBackfillLocalePartition();
if (partitionIssues.length > 0) {
  throw new Error(partitionIssues.join("\n"));
}

const fallbackBaseline = JSON.parse(
  fs.readFileSync(fallbackBaselinePath, "utf8"),
) as FallbackBaseline;
const fallbackCounts = new Map<string, number>();
for (const locales of Object.values(fallbackBaseline.fallbacks)) {
  for (const locale of locales) {
    fallbackCounts.set(locale, (fallbackCounts.get(locale) ?? 0) + 1);
  }
}

const inventory = await collectNativeI18nEntries();
const nativeFindings = await checkNativeLocaleArtifacts(inventory);
const nativeFindingCounts = new Map<string, number>();
for (const finding of nativeFindings) {
  nativeFindingCounts.set(finding.locale, (nativeFindingCounts.get(finding.locale) ?? 0) + 1);
}

const docsLocales = new Set<string>(GENERATED_LOCALES.map((entry) => entry.dir));
const constrainedDocsLocales = new Set<string>(DOCS_PLATFORM_CONSTRAINED_LOCALES);
const nativeLocales = new Set<string>(NATIVE_I18N_LOCALES);
const appleLocales = new Set<string>(APPLE_I18N_LOCALES);
const appleCatalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, "apps", "ios", "Resources", "Localizable.xcstrings"), "utf8"),
) as AppleCatalog;
const appleCatalogEntries = Object.values(appleCatalog.strings ?? {});
const readReviewManifest = (
  fileName: string,
  expectedLocales: readonly string[],
): ReviewManifest => {
  const manifest = JSON.parse(fs.readFileSync(path.join(localizationDir, fileName), "utf8")) as
    | ReviewManifest
    | undefined;
  const reviewLocales = Object.keys(manifest?.locales ?? {}).toSorted();
  if (
    manifest?.version !== 1 ||
    reviewLocales.join("\u0000") !== [...expectedLocales].toSorted().join("\u0000")
  ) {
    throw new Error(`${fileName} must contain every scoped locale exactly`);
  }
  for (const [locale, review] of Object.entries(manifest.locales)) {
    if (
      (review.status !== "pending" && review.status !== "reviewed") ||
      (review.status === "reviewed" && !review.languageOwner?.trim())
    ) {
      throw new Error(`invalid review evidence for ${locale} in ${fileName}`);
    }
  }
  return manifest;
};

const buildLocaleStates = (
  scopedLocales: readonly string[],
  reviewManifest: ReviewManifest,
): Record<string, BackfillLocaleState> =>
  Object.fromEntries(
    scopedLocales.map((locale) => {
      const review = reviewManifest.locales[locale];
      if (!review) {
        throw new Error(`missing localization review evidence for ${locale}`);
      }
      const androidArtifactPath = path.join(
        ROOT,
        "apps",
        "android",
        "app",
        "src",
        "main",
        "res",
        getAndroidLocaleDirectory(locale),
        "strings.xml",
      );
      const docsStatus = constrainedDocsLocales.has(locale)
        ? "platform-constrained"
        : docsLocales.has(locale)
          ? "supported"
          : "unsupported";
      const evidence: BackfillLocaleEvidence = {
        controlUi: {
          supported: supportsLocale(CONTROL_UI_LOCALES, locale),
          fallbackCount: fallbackCounts.get(locale) ?? 0,
        },
        cliOnboarding: { supported: supportsLocale(WIZARD_LOCALES, locale) },
        cli: { supported: supportsLocale(CLI_SUPPORTED_LOCALES, locale) },
        tui: { supported: supportsLocale(TUI_SUPPORTED_LOCALES, locale) },
        docs: { status: docsStatus },
        native: {
          sharedArtifact: nativeLocales.has(locale),
          androidArtifact: fs.existsSync(androidArtifactPath),
          appleArtifact:
            appleLocales.has(locale) &&
            appleCatalogEntries.length > 0 &&
            appleCatalogEntries.every((entry) =>
              Boolean(entry.localizations?.[locale]?.stringUnit?.value?.trim()),
            ),
          qualityAdvisories: nativeFindingCounts.get(locale) ?? 0,
        },
        review,
      };
      return [locale, evaluateBackfillLocale(evidence)];
    }),
  );

const simpleLocales = buildLocaleStates(
  SIMPLER_SCRIPT_LOCALES,
  readReviewManifest("simple-script-reviews.json", SIMPLER_SCRIPT_LOCALES),
);
const complexLocales = buildLocaleStates(
  COMPLEX_SCRIPT_LOCALES,
  readReviewManifest("complex-script-reviews.json", COMPLEX_SCRIPT_LOCALES),
);
const simpleReport = {
  version: 1,
  scope: "registered-non-rtl-simple-shaping",
  locales: simpleLocales,
};
const complexReport = {
  version: 1,
  scope: "registered-complex-script-and-rtl",
  profiles: COMPLEX_SCRIPT_PROFILES,
  locales: complexLocales,
};
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as {
  surfaces: Record<string, { locales: Record<string, { maturity: string }> }>;
};
const releaseReadiness = evaluateLocalizationReleaseReadiness(coverage);
const allBackfillStates = { ...simpleLocales, ...complexLocales };
const releaseReport = {
  version: 1,
  ...releaseReadiness,
  sources: {
    coverage: "localization/coverage.json",
    simplerScript: "localization/simple-script-backfill.json",
    complexScript: "localization/complex-script-backfill.json",
  },
  conformance: {
    complexScriptCatalogs: "ui/src/i18n/test/translate.test.ts",
    rtlInterpolation: "packages/localization-core/src/catalog.test.ts",
    rtlTerminalIsolation: "src/tui/tui-formatters.test.ts",
  },
  backfill: Object.fromEntries(
    Object.entries(allBackfillStates).map(([locale, state]) => [
      locale,
      {
        blockers: state.blockers,
        promotionEligible: state.promotionEligible,
      },
    ]),
  ),
};

const outputs = [
  [simpleOutputPath, simpleReport],
  [complexOutputPath, complexReport],
  [releaseOutputPath, releaseReport],
] as const;
const stale: string[] = [];
for (const [outputPath, report] of outputs) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (write) {
    fs.writeFileSync(outputPath, serialized);
    process.stdout.write(`wrote ${path.relative(process.cwd(), outputPath)}\n`);
    continue;
  }
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== serialized) {
    stale.push(path.relative(ROOT, outputPath));
  }
}
if (stale.length > 0) {
  throw new Error(
    `localization backfill reports are stale: ${stale.join(", ")}; run pnpm localization:backfill:sync`,
  );
}
