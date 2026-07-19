import { describe, expect, it } from "vitest";
import { resolveLocalizationContext, resolveProcessLocalizationContext } from "./context.js";

describe("localization context", () => {
  it("uses strict stored preferences before inferred platform locales", () => {
    const result = resolveLocalizationContext({
      audience: "user",
      surfacePreference: "fa",
      platform: ["de-DE"],
    });
    expect(result.context).toEqual({
      locale: "fa",
      fallbackLocales: ["en"],
      source: "surface-preference",
      audience: "user",
    });
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("uses an exact explicit recipient locale before lower preference tiers", () => {
    const result = resolveLocalizationContext({
      audience: "operator",
      explicitRecipient: "zh-Hans",
      request: "de",
      surfacePreference: "fr",
      platform: ["es-MX"],
      supportedLocales: ["en", "zh-CN"],
    });

    expect(result).toEqual({
      context: {
        locale: "zh-CN",
        fallbackLocales: ["en"],
        source: "explicit-recipient",
        audience: "operator",
      },
      findings: [],
    });
  });

  it("rejects malformed and unsupported explicit recipient locales with bounded findings", () => {
    const malformed = resolveLocalizationContext({
      audience: "operator",
      explicitRecipient: "not_a_locale",
      supportedLocales: ["en", "zh-CN"],
    });
    const unsupported = resolveLocalizationContext({
      audience: "operator",
      explicitRecipient: "de",
      supportedLocales: ["en", "zh-CN"],
    });

    expect(malformed).toEqual({
      context: {
        locale: "en",
        fallbackLocales: [],
        source: "english-default",
        audience: "operator",
      },
      findings: [
        {
          source: "explicit-recipient",
          value: "not_a_locale",
          reason: "invalid",
        },
      ],
    });
    expect(unsupported.findings).toEqual([
      {
        source: "explicit-recipient",
        value: "de",
        reason: "unsupported-by-surface",
      },
    ]);
    expect(unsupported.context.locale).toBe("en");
  });

  it("ignores a stale stored preference and records a bounded finding", () => {
    const result = resolveLocalizationContext({
      audience: "user",
      surfacePreference: "xx-invalid",
      platform: ["de-DE"],
    });
    expect(result.context.locale).toBe("de");
    expect(result.findings).toEqual([
      {
        source: "surface-preference",
        value: "xx-invalid",
        reason: "invalid",
      },
    ]);
  });

  it("falls directly to English for an invalid explicit process override", () => {
    const result = resolveProcessLocalizationContext(
      {
        OPENCLAW_LOCALE: "xx-invalid",
        LC_ALL: "zh-CN",
      },
      { audience: "operator", supportedLocales: ["en", "zh-CN", "zh-TW"] },
    );
    expect(result.context.locale).toBe("en");
    expect(result.context.source).toBe("english-default");
  });

  it("continues through unsupported inferred process locales", () => {
    const result = resolveProcessLocalizationContext(
      {
        LC_ALL: "de-DE",
        LC_MESSAGES: "zh-Hant",
      },
      { audience: "operator", supportedLocales: ["en", "zh-CN", "zh-TW"] },
    );
    expect(result.context.locale).toBe("zh-TW");
  });

  it("uses runtime platform locales when Windows has no POSIX locale variables", () => {
    const result = resolveProcessLocalizationContext(
      {},
      {
        audience: "operator",
        supportedLocales: ["en", "zh-CN", "zh-TW"],
        platform: ["zh-Hant-HK"],
      },
    );
    expect(result.context.locale).toBe("zh-TW");
    expect(result.context.source).toBe("platform");
  });
});
