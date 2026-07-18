import { describe, expect, it } from "vitest";
import { findHardcodedTuiCopy } from "../../scripts/check-tui-localization.js";

describe("TUI localization hardcoded-copy guard", () => {
  it("flags migrated product copy in executable literals", () => {
    const findings = findHardcodedTuiCopy('chatLog.addSystem("Gateway status");');

    expect(findings).toEqual([
      expect.objectContaining({
        line: 1,
        phrase: "Gateway status",
      }),
    ]);
  });

  it("ignores comments, protocol tokens, commands, and localization keys", () => {
    const findings = findHardcodedTuiCopy(`
      // Gateway status remains the English catalog value.
      const sessionKey = "global";
      const command = "/auth";
      const activityStatus = "abort failed";
      localization.t("tui.status.heading");
    `);

    expect(findings).toEqual([]);
  });
});
