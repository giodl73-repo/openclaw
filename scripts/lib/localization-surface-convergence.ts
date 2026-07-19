import {
  getLocaleDirection,
  OPENCLAW_LOCALES,
  type OpenClawLocale,
} from "../../packages/localization-core/src/locale-registry.js";
import type { DocsGeneratedLocale } from "./docs-i18n-locales.mjs";

export const CONTROL_UI_OMITTED_LOCALES = ["sv"] as const satisfies readonly OpenClawLocale[];
export const DOCS_OMITTED_LOCALES = ["sv"] as const satisfies readonly OpenClawLocale[];
export const DOCS_PLATFORM_CONSTRAINED_LOCALES = [
  "th",
  "fa",
] as const satisfies readonly OpenClawLocale[];

type SurfaceLocaleState = {
  controlUiEntries: readonly string[];
  controlUiLocales: readonly OpenClawLocale[];
  nativeLocales: readonly OpenClawLocale[];
  appleLocales: readonly OpenClawLocale[];
  docsLocales: readonly DocsGeneratedLocale[];
  androidLocaleDirectory: (locale: string) => string;
  appleLocaleDirectory: (locale: string) => string;
};

export const EXPECTED_CONTROL_UI_LOCALES = OPENCLAW_LOCALES.filter(
  (locale): locale is Exclude<OpenClawLocale, "sv"> => locale !== "sv",
);
export const EXPECTED_NATIVE_LOCALES = OPENCLAW_LOCALES.filter(
  (locale): locale is Exclude<OpenClawLocale, "en"> => locale !== "en",
);
export const EXPECTED_DOCS_LOCALES = EXPECTED_NATIVE_LOCALES.filter(
  (locale): locale is Exclude<OpenClawLocale, "en" | "sv"> => locale !== "sv",
);

const DOCS_LANGUAGE_TAGS: Readonly<Partial<Record<OpenClawLocale, string>>> = {
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
  "ja-JP": "ja",
};
const ANDROID_QUALIFIERS: Readonly<Partial<Record<OpenClawLocale, string>>> = {
  id: "in",
  "zh-CN": "zh-rCN",
  "zh-TW": "zh-rTW",
  "pt-BR": "pt-rBR",
  "ja-JP": "ja",
};
const APPLE_LOCALE_DIRECTORIES: Readonly<Partial<Record<OpenClawLocale, string>>> = {
  "ja-JP": "ja",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

function compareSequence(label: string, actual: readonly string[], expected: readonly string[]) {
  return actual.join("\u0000") === expected.join("\u0000")
    ? []
    : [`${label}: expected ${expected.join(",")}; got ${actual.join(",")}`];
}

export function findLocalizationSurfaceConvergenceIssues(state: SurfaceLocaleState): string[] {
  const issues = [
    ...compareSequence(
      "Control UI locale inventory",
      state.controlUiLocales,
      EXPECTED_CONTROL_UI_LOCALES,
    ),
    ...compareSequence(
      "Control UI translation entries",
      state.controlUiEntries,
      EXPECTED_CONTROL_UI_LOCALES.filter((locale) => locale !== "en"),
    ),
    ...compareSequence("native locale inventory", state.nativeLocales, EXPECTED_NATIVE_LOCALES),
    ...compareSequence("Apple locale inventory", state.appleLocales, EXPECTED_NATIVE_LOCALES),
    ...compareSequence(
      "docs locale inventory",
      state.docsLocales.map((entry) => entry.dir),
      EXPECTED_DOCS_LOCALES,
    ),
  ];

  for (const locale of EXPECTED_DOCS_LOCALES) {
    const entry = state.docsLocales.find((candidate) => candidate.dir === locale);
    if (!entry) {
      continue;
    }
    const language = DOCS_LANGUAGE_TAGS[locale] ?? locale;
    const expected = {
      language,
      navFile: `${language}-navigation.json`,
      tmFile: `${locale}.tm.jsonl`,
      navMode: locale === "zh-CN" ? "overlay" : "clone-en",
      navigation: DOCS_PLATFORM_CONSTRAINED_LOCALES.some((candidate) => candidate === locale)
        ? false
        : undefined,
    };
    for (const key of ["language", "navFile", "tmFile", "navMode", "navigation"] as const) {
      if (entry[key] !== expected[key]) {
        issues.push(
          `docs ${locale} ${key}: expected ${String(expected[key])}; got ${String(entry[key])}`,
        );
      }
    }
  }

  for (const locale of EXPECTED_NATIVE_LOCALES) {
    const androidQualifier = ANDROID_QUALIFIERS[locale] ?? locale;
    const androidDirectory = `values-${androidQualifier}`;
    if (state.androidLocaleDirectory(locale) !== androidDirectory) {
      issues.push(
        `Android ${locale} directory: expected ${androidDirectory}; got ${state.androidLocaleDirectory(locale)}`,
      );
    }
    const appleDirectory = APPLE_LOCALE_DIRECTORIES[locale] ?? locale;
    if (state.appleLocaleDirectory(locale) !== appleDirectory) {
      issues.push(
        `Apple ${locale} directory: expected ${appleDirectory}; got ${state.appleLocaleDirectory(locale)}`,
      );
    }
  }

  const rtlLocales = OPENCLAW_LOCALES.filter((locale) => getLocaleDirection(locale) === "rtl");
  for (const locale of rtlLocales) {
    if (
      !state.controlUiLocales.includes(locale) ||
      !state.nativeLocales.includes(locale) ||
      !state.docsLocales.some((entry) => entry.dir === locale)
    ) {
      issues.push(`RTL locale ${locale} is not represented across UI, native, and docs`);
    }
  }

  return issues;
}
