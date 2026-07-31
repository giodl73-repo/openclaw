import { describe, expect, it } from "vitest";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import policyPlugin from "./index.js";

describe("policy plugin entry", () => {
  it("registers an active policy settings constraints provider", () => {
    const captured = createCapturedPluginRegistration({
      id: "policy",
      name: "Policy",
    });

    policyPlugin.register(captured.api);

    expect(captured.settingsConstraintsProviders).toEqual([
      expect.objectContaining({
        id: "policy",
        description: expect.stringContaining("settings UI and config writes"),
        build: expect.any(Function),
      }),
    ]);
  });
});
