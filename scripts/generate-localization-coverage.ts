import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_LOCALIZATION_SURFACES,
  requiredChecksForSurface,
  requiredPromotionBlockersForSurface,
  validateLocalizationCoverageManifest,
  type LocalizationContentClass,
  type LocalizationCoverageManifest,
  type LocalizationLocaleState,
  type LocalizationMaturity,
  type LocalizationMigrationState,
  type LocalizationSurfaceId,
} from "../packages/localization-core/src/coverage.js";
import {
  OPENCLAW_LOCALES,
  OPENCLAW_LOCALE_REGISTRY_REVISION,
  type OpenClawLocale,
} from "../packages/localization-core/src/locale-registry.js";
import { CLI_SUPPORTED_LOCALES } from "../src/cli/i18n/runtime.js";
import { TUI_SUPPORTED_LOCALES } from "../src/tui/i18n/runtime.js";
import { WIZARD_LOCALES } from "../src/wizard/i18n/index.js";
import { SUPPORTED_LOCALES as CONTROL_UI_LOCALES } from "../ui/src/i18n/lib/registry.js";
import { APPLE_I18N_LOCALES } from "./apple-app-i18n.js";
import { computeLocalizationCatalogRevision } from "./lib/localization-catalog-revision.js";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.js";

type SurfaceSeed = {
  owner: string;
  artifactId: string;
  catalogRevision?: "none";
  source: string;
  catalogs?: string;
  migration: LocalizationMigrationState;
  validationCommand: string;
  contentClasses: readonly LocalizationContentClass[];
  completeLocales?: readonly OpenClawLocale[];
  platformConstrainedLocales?: readonly OpenClawLocale[];
  localeArtifact?: (locale: Exclude<OpenClawLocale, "en">) => string;
  supportedLocales?: readonly OpenClawLocale[];
  revisionPaths?: readonly string[];
};

const ROOT = path.resolve(import.meta.dirname, "..");
const catalogFile =
  (directory: string, extension = ".ts") =>
  (locale: Exclude<OpenClawLocale, "en">): string =>
    path.join(directory, `${locale}${extension}`);
const docsGlossary = (locale: Exclude<OpenClawLocale, "en">): string =>
  path.join("docs/.i18n", `glossary.${locale}.json`);

const SURFACE_SEEDS: Record<LocalizationSurfaceId, SurfaceSeed> = {
  "control-ui": {
    owner: "control-ui",
    artifactId: "control-ui-web",
    source: "ui/src/i18n/locales/en.ts",
    catalogs: "ui/src/i18n/locales",
    migration: "migrated",
    validationCommand: "pnpm ui:i18n:verify",
    contentClasses: ["general", "authentication", "recovery"],
    localeArtifact: catalogFile("ui/src/i18n/locales"),
    supportedLocales: CONTROL_UI_LOCALES,
  },
  "cli-onboarding": {
    owner: "cli",
    artifactId: "openclaw-cli",
    source: "src/wizard/i18n/locales/en.ts",
    catalogs: "src/wizard/i18n/locales",
    migration: "migrated",
    validationCommand: "node scripts/run-vitest.mjs run src/wizard/i18n/index.test.ts",
    contentClasses: ["general", "authentication", "recovery"],
    localeArtifact: catalogFile("src/wizard/i18n/locales"),
    supportedLocales: WIZARD_LOCALES,
  },
  "channel-plugin-setup": {
    owner: "channels",
    artifactId: "openclaw-cli",
    source: "src/wizard/i18n/locales/en.ts",
    catalogs: "src/wizard/i18n/locales",
    migration: "migrated",
    validationCommand: "node scripts/run-vitest.mjs run src/wizard/i18n/index.test.ts",
    contentClasses: ["general", "authentication", "recovery"],
    localeArtifact: catalogFile("src/wizard/i18n/locales"),
    supportedLocales: WIZARD_LOCALES,
  },
  cli: {
    owner: "cli",
    artifactId: "openclaw-cli",
    source: "src/cli/i18n/locales/en.ts",
    catalogs: "src/cli/i18n/locales",
    migration: "migrated",
    validationCommand:
      "node scripts/run-vitest.mjs run src/cli/i18n/runtime.test.ts src/cli/logs-cli.test.ts",
    contentClasses: ["general", "recovery"],
    localeArtifact: catalogFile("src/cli/i18n/locales"),
    supportedLocales: CLI_SUPPORTED_LOCALES,
  },
  tui: {
    owner: "tui",
    artifactId: "openclaw-cli",
    source: "src/tui/i18n/locales/en.ts",
    catalogs: "src/tui/i18n/locales",
    migration: "migrated",
    validationCommand: "pnpm tui:localization:check",
    contentClasses: ["general", "recovery"],
    localeArtifact: catalogFile("src/tui/i18n/locales"),
    supportedLocales: TUI_SUPPORTED_LOCALES,
  },
  runtime: unmigrated("core-runtime", "openclaw-runtime", "src", [
    "general",
    "safety",
    "security",
    "authentication",
    "authorization",
    "destructive-action",
    "privacy",
    "recovery",
  ]),
  "gateway-errors": unmigrated(
    "gateway",
    "openclaw-gateway",
    "packages/gateway-protocol/src/schema/error-codes.ts",
    ["general", "authentication", "authorization", "recovery"],
  ),
  "server-rendered-channels": unmigrated("channels", "openclaw-runtime", "src/infra", [
    "general",
    "safety",
    "security",
    "recovery",
  ]),
  "command-metadata": unmigrated("command-catalog", "openclaw-runtime", "src/commands", [
    "general",
  ]),
  "telegram-command-menu": unmigrated(
    "telegram",
    "openclaw-plugin-telegram",
    "extensions/telegram",
    ["general"],
  ),
  "discord-command-menu": unmigrated("discord", "openclaw-plugin-discord", "extensions/discord", [
    "general",
  ]),
  "skill-metadata": unmigrated("skills", "openclaw-runtime", "src/skills", ["general"]),
  android: {
    owner: "android",
    artifactId: "openclaw-android",
    source: "apps/.i18n/native-source.json",
    catalogs: "apps/.i18n/native",
    migration: "migrated",
    validationCommand: "pnpm android:i18n:check",
    contentClasses: ["general", "safety", "security", "authentication", "recovery", "generated"],
    localeArtifact: catalogFile("apps/.i18n/native", ".json"),
    supportedLocales: ["en", ...NATIVE_I18N_LOCALES],
  },
  apple: {
    owner: "apple",
    artifactId: "openclaw-apple",
    source: "apps/.i18n/native-source.json",
    catalogs: "apps/.i18n/native",
    migration: "migrated",
    validationCommand: "pnpm apple:i18n:check",
    contentClasses: ["general", "safety", "security", "authentication", "recovery", "generated"],
    localeArtifact: catalogFile("apps/.i18n/native", ".json"),
    supportedLocales: ["en", ...APPLE_I18N_LOCALES],
  },
  docs: {
    owner: "docs",
    artifactId: "openclaw-docs",
    source: "docs",
    catalogs: "docs/.i18n",
    migration: "external",
    validationCommand: "pnpm docs:check-i18n-glossary",
    revisionPaths: ["docs/.i18n"],
    contentClasses: ["general", "security", "authentication", "recovery", "generated"],
    localeArtifact: docsGlossary,
  },
};

const outputPath = path.resolve(import.meta.dirname, "../localization/coverage.json");
const write = process.argv.includes("--write");
const manifest = createManifest();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (write) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
} else {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== serialized) {
    console.error("localization coverage manifest is stale; run pnpm localization:coverage:sync");
    process.exitCode = 1;
  }
}

function createManifest(): LocalizationCoverageManifest {
  const surfaces = Object.fromEntries(
    REQUIRED_LOCALIZATION_SURFACES.map((surfaceId) => {
      const seed = SURFACE_SEEDS[surfaceId];
      validateSeedPaths(surfaceId, seed);
      const locales = createLocaleRows(seed);
      const surfaceWithoutBlockers = {
        owner: seed.owner,
        artifactId: seed.artifactId,
        catalogRevision: catalogRevision(seed),
        source: seed.source,
        ...(seed.catalogs ? { catalogs: seed.catalogs } : {}),
        migration: seed.migration,
        validationCommand: seed.validationCommand,
        contentClasses: seed.contentClasses,
        checks: requiredChecksForSurface({ contentClasses: seed.contentClasses, locales }),
        locales,
      };
      const surface = {
        ...surfaceWithoutBlockers,
        promotionBlockers: requiredPromotionBlockersForSurface(surfaceWithoutBlockers),
      };
      return [surfaceId, surface];
    }),
  ) as LocalizationCoverageManifest["surfaces"];

  const generatedManifest: LocalizationCoverageManifest = {
    version: 1,
    localeRegistry: "packages/localization-core/src/locale-registry.ts",
    registryRevision: OPENCLAW_LOCALE_REGISTRY_REVISION,
    testFixtures: {
      "pseudo-expanded": { kind: "expansion", direction: "ltr" },
      "pseudo-bidi": { kind: "bidirectional", direction: "rtl" },
      "he-rtl": { kind: "bidirectional", direction: "rtl", languageTag: "he" },
      "bn-indic": { kind: "shaping", direction: "ltr", languageTag: "bn" },
      "km-segmentation": { kind: "segmentation", direction: "ltr", languageTag: "km" },
      "am-ethiopic": { kind: "shaping", direction: "ltr", languageTag: "am" },
    },
    surfaces,
  };
  const issues = validateLocalizationCoverageManifest(generatedManifest);
  if (issues.length > 0) {
    throw new Error(issues.map((entry) => `${entry.path}: ${entry.detail}`).join("\n"));
  }
  return generatedManifest;
}

function createLocaleRows(seed: SurfaceSeed): Record<OpenClawLocale, LocalizationLocaleState> {
  return Object.fromEntries(
    OPENCLAW_LOCALES.map((locale) => {
      const maturity = maturityForLocale(seed, locale);
      return [
        locale,
        {
          maturity,
          ...(maturity === "complete" ? { languageOwner: "openclaw-localization" } : {}),
        },
      ];
    }),
  ) as Record<OpenClawLocale, LocalizationLocaleState>;
}

function maturityForLocale(seed: SurfaceSeed, locale: OpenClawLocale): LocalizationMaturity {
  if (locale === "en") {
    return "source";
  }
  if (seed.completeLocales?.includes(locale)) {
    return "complete";
  }
  if (seed.platformConstrainedLocales?.includes(locale)) {
    return "platform-constrained";
  }
  const artifact = seed.localeArtifact?.(locale);
  const supported = seed.supportedLocales?.includes(locale) ?? Boolean(artifact);
  if (supported && artifact && fs.existsSync(path.resolve(ROOT, artifact))) {
    return "partial";
  }
  return "unsupported";
}

function unmigrated(
  owner: string,
  artifactId: string,
  source: string,
  contentClasses: readonly LocalizationContentClass[],
): SurfaceSeed {
  return {
    owner,
    artifactId,
    catalogRevision: "none",
    source,
    migration: "unmigrated",
    validationCommand: "pnpm localization:coverage:check",
    contentClasses,
  };
}

function catalogRevision(seed: SurfaceSeed): string {
  if (seed.catalogRevision === "none") {
    return "none";
  }
  return computeLocalizationCatalogRevision(
    ROOT,
    seed.revisionPaths ??
      [seed.source, seed.catalogs].filter((value): value is string => Boolean(value)),
  );
}

function validateSeedPaths(surfaceId: LocalizationSurfaceId, seed: SurfaceSeed): void {
  const declaredPaths = new Set([seed.source, seed.catalogs, ...(seed.revisionPaths ?? [])]);
  for (const candidate of declaredPaths) {
    if (candidate && !fs.existsSync(path.resolve(ROOT, candidate))) {
      throw new Error(`localization surface ${surfaceId} references missing path: ${candidate}`);
    }
  }
  for (const locale of seed.supportedLocales ?? []) {
    if (locale === "en") {
      continue;
    }
    const artifact = seed.localeArtifact?.(locale);
    if (!artifact || !fs.existsSync(path.resolve(ROOT, artifact))) {
      throw new Error(
        `localization surface ${surfaceId} is missing its ${locale} catalog artifact`,
      );
    }
  }
}
