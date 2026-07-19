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
  evaluateBackfillLocale,
  SIMPLER_SCRIPT_LOCALES,
  validateBackfillLocalePartition,
  type BackfillLocaleEvidence,
} from "./lib/localization-backfill-contract.js";
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
const outputPath = path.join(ROOT, "localization", "simple-script-backfill.json");
const reviewManifestPath = path.join(ROOT, "localization", "simple-script-reviews.json");
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
const reviewManifest = JSON.parse(fs.readFileSync(reviewManifestPath, "utf8")) as ReviewManifest;
const reviewLocales = Object.keys(reviewManifest.locales).toSorted();
if (
  reviewManifest.version !== 1 ||
  reviewLocales.join("\u0000") !== [...SIMPLER_SCRIPT_LOCALES].toSorted().join("\u0000")
) {
  throw new Error("simple-script review manifest must contain every simpler-script locale exactly");
}
for (const [locale, review] of Object.entries(reviewManifest.locales)) {
  if (
    (review.status !== "pending" && review.status !== "reviewed") ||
    (review.status === "reviewed" && !review.languageOwner?.trim())
  ) {
    throw new Error(`invalid simple-script review evidence for ${locale}`);
  }
}
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
const nativeLocales = new Set<string>(NATIVE_I18N_LOCALES);
const appleLocales = new Set<string>(APPLE_I18N_LOCALES);
const appleCatalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, "apps", "ios", "Resources", "Localizable.xcstrings"), "utf8"),
) as AppleCatalog;
const appleCatalogEntries = Object.values(appleCatalog.strings ?? {});
const locales = Object.fromEntries(
  SIMPLER_SCRIPT_LOCALES.map((locale) => {
    const review = reviewManifest.locales[locale];
    if (!review) {
      throw new Error(`missing simple-script review evidence for ${locale}`);
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
    const evidence: BackfillLocaleEvidence = {
      controlUi: {
        supported: supportsLocale(CONTROL_UI_LOCALES, locale),
        fallbackCount: fallbackCounts.get(locale) ?? 0,
      },
      cliOnboarding: { supported: supportsLocale(WIZARD_LOCALES, locale) },
      cli: { supported: supportsLocale(CLI_SUPPORTED_LOCALES, locale) },
      tui: { supported: supportsLocale(TUI_SUPPORTED_LOCALES, locale) },
      docs: { supported: docsLocales.has(locale) },
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

const report = {
  version: 1,
  scope: "registered-non-rtl-simple-shaping",
  locales,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (write) {
  fs.writeFileSync(outputPath, serialized);
  process.stdout.write(`wrote ${path.relative(process.cwd(), outputPath)}\n`);
} else {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== serialized) {
    throw new Error(
      "simple-script localization backfill report is stale; run pnpm localization:backfill:sync",
    );
  }
}
