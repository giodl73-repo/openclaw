import { describe, expect, it } from "vitest";
import type { DocsGeneratedLocale } from "../../scripts/lib/docs-i18n-locales.mjs";
import {
  EXPECTED_CONTROL_UI_LOCALES,
  EXPECTED_DOCS_LOCALES,
  EXPECTED_NATIVE_LOCALES,
  findLocalizationSurfaceConvergenceIssues,
} from "../../scripts/lib/localization-surface-convergence.js";

const docsLocales = EXPECTED_DOCS_LOCALES.map((locale): DocsGeneratedLocale => {
  const language =
    locale === "zh-CN"
      ? "zh-Hans"
      : locale === "zh-TW"
        ? "zh-Hant"
        : locale === "ja-JP"
          ? "ja"
          : locale;
  const entry: DocsGeneratedLocale = {
    language,
    dir: locale,
    navFile: `${language}-navigation.json`,
    tmFile: `${locale}.tm.jsonl`,
    navMode: locale === "zh-CN" ? "overlay" : "clone-en",
  };
  if (locale === "fa" || locale === "th") {
    entry.navigation = false;
  }
  return entry;
});

function fixture() {
  return {
    controlUiEntries: EXPECTED_CONTROL_UI_LOCALES.filter((locale) => locale !== "en"),
    controlUiLocales: EXPECTED_CONTROL_UI_LOCALES,
    nativeLocales: EXPECTED_NATIVE_LOCALES,
    appleLocales: EXPECTED_NATIVE_LOCALES,
    docsLocales,
    androidLocaleDirectory: (locale: string) =>
      `values-${
        {
          id: "in",
          "zh-CN": "zh-rCN",
          "zh-TW": "zh-rTW",
          "pt-BR": "pt-rBR",
          "ja-JP": "ja",
        }[locale] ?? locale
      }`,
    appleLocaleDirectory: (locale: string) =>
      ({ "ja-JP": "ja", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" })[locale] ?? locale,
  };
}

describe("localization surface convergence", () => {
  it("accepts the declared cross-surface contract", () => {
    expect(findLocalizationSurfaceConvergenceIssues(fixture())).toEqual([]);
  });

  it("reports inventory, host mapping, and platform-constraint drift", () => {
    const state = fixture();
    expect(
      findLocalizationSurfaceConvergenceIssues({
        ...state,
        controlUiLocales: [...state.controlUiLocales, "sv"],
        docsLocales: state.docsLocales.map((entry) =>
          entry.dir === "fa" ? { ...entry, navigation: undefined } : entry,
        ),
        androidLocaleDirectory: (locale) =>
          locale === "id" ? "values-id" : state.androidLocaleDirectory(locale),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Control UI locale inventory"),
        expect.stringContaining("docs fa navigation"),
        expect.stringContaining("Android id directory"),
      ]),
    );
  });
});
