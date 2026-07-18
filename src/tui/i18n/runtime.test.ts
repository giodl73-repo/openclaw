import { describe, expect, it } from "vitest";
import {
  createTuiLocalization,
  getTuiWaitingPhrases,
  localizeTuiActivityStatus,
} from "./runtime.js";

describe("TUI runtime localization", () => {
  it("resolves one immutable explicit localization context", () => {
    const localization = createTuiLocalization({ locale: "zh-CN" });

    expect(Object.isFrozen(localization)).toBe(true);
    expect(Object.isFrozen(localization.context)).toBe(true);
    expect(localization.context.locale).toBe("zh-CN");
    expect(localization.t("tui.connection.connecting")).toBe("正在连接");
  });

  it("preserves protected commands and literal parameter values", () => {
    const localization = createTuiLocalization({ locale: "zh-CN" });
    const reason = "gateway closed (1008): scope upgrade";
    const rendered = localization.t("tui.connection.gatewayDisconnected", { reason });
    const recovery = localization.t("tui.recovery.deviceApproval");

    expect(rendered).toContain(reason);
    expect(recovery).toContain("openclaw devices approve --latest");
    expect(recovery).toContain("openclaw devices approve <requestId>");
    expect(recovery).toContain("--token");
  });

  it("falls back to reviewed English for locales without a TUI catalog", () => {
    const localization = createTuiLocalization({ locale: "fr" });

    expect(localization.t("tui.command.help.description")).toBe("Show slash command help");
  });

  it("localizes typed display statuses", () => {
    const localization = createTuiLocalization({ locale: "zh-CN" });

    expect(localizeTuiActivityStatus(localization, "streaming")).toBe("流式传输中");
    expect(getTuiWaitingPhrases(localization)).toContain("思考中");
  });
});
