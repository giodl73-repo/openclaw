import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("hosting config schema", () => {
  it("accepts built-in hosting profiles", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "container",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hosting?.profile).toBe("container");
    }
  });

  it("accepts an additive namespaced custom profile", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "acme/managed",
        profiles: {
          "acme/managed": {
            extends: "container",
            requiredCriteria: ["plugin.storage.backend"],
            advisoryCriteria: ["plugin.metrics.exporter"],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hosting?.profile).toBe("acme/managed");
    }
  });

  it("rejects custom profile names without a namespace", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profiles: { custom: { extends: "local" } },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects selection of an undefined custom profile", () => {
    const result = validateConfigObjectRaw({ hosting: { profile: "acme/missing" } });

    expect(result.ok).toBe(false);
  });

  it("rejects conflicting custom criterion requirements", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profiles: {
          "acme/managed": {
            extends: "local",
            requiredCriteria: ["plugin.storage.backend"],
            advisoryCriteria: ["plugin.storage.backend"],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
