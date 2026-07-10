import { describe, expect, it } from "vitest";
import { normalizeCatalogExposure, normalizeCommandEffectProfile } from "./catalog-metadata.js";

describe("catalog metadata normalization", () => {
  it("preserves valid source-owned metadata", () => {
    expect(
      normalizeCommandEffectProfile({
        effectMode: "mutating",
        risk: "medium",
        confirmationRequired: true,
      }),
    ).toEqual({
      effectMode: "mutating",
      risk: "medium",
      confirmationRequired: true,
    });
    expect(normalizeCatalogExposure({ tier: "internal" })).toEqual({ tier: "internal" });
  });

  it("drops malformed or expanded metadata shapes", () => {
    expect(normalizeCommandEffectProfile({ effectMode: "write" })).toBeUndefined();
    expect(
      normalizeCommandEffectProfile({ effectMode: "read", commandHints: ["not source-owned"] }),
    ).toBeUndefined();
    expect(normalizeCatalogExposure({ tier: "private" })).toBeUndefined();
  });
});
