import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import {
  CONTINUITY_LEVELS,
  listContinuityStateSurfaces,
  resolveContinuityStatus,
} from "./state-inventory.js";

describe("continuity owner model", () => {
  it("preserves Conventional behavior when continuity config is absent", () => {
    const status = resolveContinuityStatus({});

    expect(status).toMatchObject({
      version: 1,
      desiredLevel: "conventional",
      effectiveLevel: "conventional",
      reasons: [],
    });
    expect(status.capabilities).toEqual([
      { level: "conventional", maturity: "available" },
      { level: "archived", maturity: "planned" },
      { level: "portable", maturity: "planned" },
      { level: "elastic", maturity: "planned" },
    ]);
  });

  it.each(CONTINUITY_LEVELS.slice(1))(
    "reports configured %s intent without claiming unsupported behavior",
    (level) => {
      const status = resolveContinuityStatus({ continuity: { level } });

      expect(status.desiredLevel).toBe(level);
      expect(status.effectiveLevel).toBe("conventional");
      expect(status.reasons).toEqual([
        expect.objectContaining({ code: `continuity.${level}.not_implemented` }),
      ]);
    },
  );

  it("classifies every core surface exactly once", () => {
    const inventory = listContinuityStateSurfaces();
    const ids = inventory.map((surface) => surface.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(inventory).not.toHaveLength(0);
    expect(inventory.every((surface) => surface.treatment.length > 0)).toBe(true);
    expect(new Set(inventory.map((surface) => surface.treatment))).toEqual(
      new Set(["captured", "reconstructed", "external", "ephemeral"]),
    );
  });

  it("keeps status inventory path-free and marks sensitive owners", () => {
    const inventory = listContinuityStateSurfaces();
    const serialized = JSON.stringify(inventory);

    expect(serialized).not.toContain(process.env.HOME ?? "/home");
    expect(serialized).not.toContain(".openclaw");
    expect(inventory.find((surface) => surface.id === "runtime-identity")).toMatchObject({
      treatment: "captured",
      sensitive: true,
    });
    expect(inventory.find((surface) => surface.id === "host-dependencies")).toMatchObject({
      owner: "host",
      treatment: "external",
      sensitive: true,
    });
  });

  it("returns inventory copies that callers cannot mutate globally", () => {
    const first = listContinuityStateSurfaces();
    first[0].description = "mutated";

    expect(listContinuityStateSurfaces()[0].description).not.toBe("mutated");
  });

  it("validates only stable CAPE level names", () => {
    expect(OpenClawSchema.safeParse({ continuity: { level: "archived" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ continuity: { level: "unknown" } }).success).toBe(false);
  });
});
