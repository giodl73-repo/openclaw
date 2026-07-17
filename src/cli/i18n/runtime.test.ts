import { describe, expect, it } from "vitest";
import { createCliLocalization } from "./runtime.js";

describe("CLI runtime localization", () => {
  it("resolves the explicit process locale once for one command context", () => {
    const localization = createCliLocalization({
      env: { OPENCLAW_LOCALE: "zh-CN" },
    });

    expect(localization.context.locale).toBe("zh-CN");
    expect(localization.t("cli.agent.timeout.invalid")).toContain("无效的 --timeout");
  });

  it("preserves protected command tokens and literal parameter values", () => {
    const localization = createCliLocalization({ locale: "zh-CN" });
    const rendered = localization.t("cli.agent.target.missing", {
      agentsListCommand: "openclaw agents list",
    });

    expect(rendered).toContain("--agent <id>");
    expect(rendered).toContain("--session-key <key>");
    expect(rendered).toContain("--session-id <id>");
    expect(rendered).toContain("--to <E.164>");
    expect(rendered).toContain("openclaw agents list");
  });

  it("falls back to reviewed English when the locale has no CLI catalog", () => {
    const localization = createCliLocalization({ locale: "fr" });

    expect(localization.t("cli.agent.response.noReply")).toBe("No reply from agent.");
  });

  it("continues past unsupported platform locales to a supported CLI locale", () => {
    const localization = createCliLocalization({
      env: {
        LC_ALL: "fr-FR",
        LC_MESSAGES: "zh_CN.UTF-8",
      },
    });

    expect(localization.context.locale).toBe("zh-CN");
    expect(localization.t("cli.agent.response.noReply")).toBe("代理没有回复。");
  });
});
