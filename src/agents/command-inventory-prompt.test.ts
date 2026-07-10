import { describe, expect, it } from "vitest";
import { buildCommandInventoryPromptSection } from "./command-inventory-prompt.js";

describe("buildCommandInventoryPromptSection", () => {
  it("renders a lean command-only routing section", () => {
    const section = buildCommandInventoryPromptSection({
      availableTools: new Set(["exec"]),
    }).join("\n");

    expect(section).toContain("## OpenClaw Commands");
    expect(section).toContain("gateway-status->openclaw gateway status");
    expect(section).toContain(
      "Do not run commands marked confirmation=user until the user explicitly confirms",
    );
    expect(section).toContain("config-unset->openclaw config unset risk=medium confirmation=user");
    expect(section).not.toContain("skill_workshop");
    expect(section).not.toContain("session_status");
    expect(section.length).toBeLessThan(1800);
    expect(Math.round(section.length / 4)).toBeLessThan(450);
  });

  it("omits host commands when exec is unavailable", () => {
    expect(buildCommandInventoryPromptSection({ availableTools: new Set(["read"]) })).toEqual([]);
  });

  it("omits host commands in sandboxed runtimes", () => {
    expect(
      buildCommandInventoryPromptSection({
        availableTools: new Set(["exec"]),
        hostCliAvailable: false,
      }),
    ).toEqual([]);
  });
});
