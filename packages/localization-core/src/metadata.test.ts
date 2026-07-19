import { describe, expect, it } from "vitest";
import { normalizeLocalizedText, resolveLocalizedText } from "./metadata.js";

describe("localized metadata", () => {
  it("normalizes product aliases into one immutable canonical map", () => {
    const result = normalizeLocalizedText({
      default: "Show available commands.",
      localizations: {
        "zh-Hans": "显示可用命令。",
        "zh-CN": "显示可用命令。",
        de: "Verfügbare Befehle anzeigen.",
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({
      default: "Show available commands.",
      localizations: {
        de: "Verfügbare Befehle anzeigen.",
        "zh-CN": "显示可用命令。",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value?.localizations)).toBe(true);
  });

  it("rejects conflicting aliases and display controls", () => {
    const result = normalizeLocalizedText({
      default: "Safe default",
      localizations: {
        "zh-Hans": "文本一",
        "zh-CN": "文本二",
        de: "bad\u001btext",
      },
    });

    expect(result.value).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "duplicate-locale",
      "invalid-translation",
    ]);
  });

  it("rejects unknown product locales but accepts exact external tags", () => {
    expect(
      normalizeLocalizedText({
        default: "Default",
        localizations: { "en-GB": "British" },
      }).issues,
    ).toMatchObject([{ code: "invalid-locale", locale: "en-GB" }]);

    const external = normalizeLocalizedText(
      {
        default: "Default",
        localizations: { en_gb: "British", "fr-CA-x-package": "Québécois" },
      },
      { scope: "external" },
    );
    expect(external.issues).toEqual([]);
    expect(external.value?.localizations).toEqual({
      "en-GB": "British",
      "fr-CA-x-package": "Québécois",
    });
  });

  it("resolves product fallback and exact external truncation deterministically", () => {
    const product = normalizeLocalizedText({
      default: "Default",
      localizations: { "zh-CN": "简体中文" },
    }).value;
    const external = normalizeLocalizedText(
      {
        default: "Default",
        localizations: { fr: "Français", "fr-CA": "Français canadien" },
      },
      { scope: "external" },
    ).value;

    expect(product && resolveLocalizedText(product, "zh-Hans")).toBe("简体中文");
    expect(product && resolveLocalizedText(product, "de")).toBe("Default");
    expect(external && resolveLocalizedText(external, "fr-CA-x-package", "external")).toBe(
      "Français canadien",
    );
  });

  it("rejects ambiguous object and legacy localization sources", () => {
    const result = normalizeLocalizedText(
      { default: "Default", localizations: { de: "Deutsch" } },
      { legacyLocalizations: { fr: "Français" } },
    );

    expect(result.value).toBeNull();
    expect(result.issues).toMatchObject([{ code: "conflicting-sources" }]);
  });
});
