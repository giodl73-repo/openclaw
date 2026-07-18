import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCALIZATION_MIGRATION_STATES,
  REQUIRED_LOCALIZATION_SURFACES,
  requiredPromotionBlockersForSurface,
  type LocalizationLocaleState,
  type LocalizationMigrationState,
  validateLocalizationCoverageManifest,
} from "./coverage.js";
import { OPENCLAW_LOCALES, type OpenClawLocale } from "./locale-registry.js";

const manifestPath = path.resolve(import.meta.dirname, "../../../localization/coverage.json");

describe("localization coverage manifest", () => {
  it("validates the checked-in baseline", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(validateLocalizationCoverageManifest(manifest)).toEqual([]);
    expect(Object.keys(manifest.surfaces)).toEqual([...REQUIRED_LOCALIZATION_SURFACES]);
    for (const surface of Object.values(manifest.surfaces) as Array<{
      migration: LocalizationMigrationState;
      promotionBlockers: string[];
      validationCommand: string;
      locales: Record<OpenClawLocale, LocalizationLocaleState>;
    }>) {
      expect(Object.keys(surface.locales)).toEqual([...OPENCLAW_LOCALES]);
      expect(LOCALIZATION_MIGRATION_STATES).toContain(surface.migration);
      expect(surface.validationCommand).not.toBe("");
      expect(surface.promotionBlockers).toEqual(requiredPromotionBlockersForSurface(surface));
    }
  });

  it("derives partial locale rows from owner catalog artifacts", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.surfaces["control-ui"].locales["zh-CN"].maturity).toBe("partial");
    expect(manifest.surfaces["control-ui"].locales.sv.maturity).toBe("unsupported");
    expect(manifest.surfaces.cli.locales["zh-CN"].maturity).toBe("partial");
    expect(manifest.surfaces.cli.locales["zh-TW"].maturity).toBe("unsupported");
    expect(manifest.surfaces.android.locales.sv.maturity).toBe("partial");
    expect(manifest.surfaces.docs.locales["zh-TW"].maturity).toBe("partial");
    expect(manifest.surfaces.docs.locales.sv.maturity).toBe("unsupported");
  });

  it("rejects a missing locale row and derived check", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces["cli-onboarding"].locales["zh-CN"] = {
      maturity: "complete",
      languageOwner: "test-owner",
    };
    delete manifest.surfaces["cli-onboarding"].locales["zh-TW"];
    manifest.surfaces["cli-onboarding"].checks = [];
    expect(validateLocalizationCoverageManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "surfaces.cli-onboarding.locales.zh-TW",
        }),
        expect.objectContaining({
          detail: "Missing derived check: key-parity.",
        }),
      ]),
    );
  });

  it("rejects missing inventory declarations", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces.cli.validationCommand = "";
    delete manifest.surfaces.cli.migration;
    expect(validateLocalizationCoverageManifest(manifest)).toEqual(
      expect.arrayContaining([
        {
          path: "surfaces.cli.validationCommand",
          detail: "validationCommand is required.",
        },
        {
          path: "surfaces.cli.migration",
          detail: "Unknown migration state.",
        },
      ]),
    );
  });

  it("rejects a missing derived promotion blocker", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces.cli.promotionBlockers = [];
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "surfaces.cli.promotionBlockers",
      detail: "Missing derived promotion blocker: incomplete-locale-coverage.",
    });
  });

  it("rejects an unexpected promotion blocker", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces.cli.promotionBlockers.push("surface-not-migrated");
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "surfaces.cli.promotionBlockers",
      detail: "Unexpected promotion blocker: surface-not-migrated.",
    });
  });

  it("rejects translated support on an unmigrated surface", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces.runtime.locales["zh-CN"] = { maturity: "partial" };
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "surfaces.runtime.locales.zh-CN.maturity",
      detail: "Unmigrated surfaces cannot claim translated locale support.",
    });
  });

  it("reports malformed locale rows without throwing", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.surfaces["cli-onboarding"].locales.en = null;
    expect(() => validateLocalizationCoverageManifest(manifest)).not.toThrow();
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "surfaces.cli-onboarding.locales.en",
      detail: "Required locale row is missing.",
    });
  });

  it("keeps engineering fixtures outside release locale rows", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.testFixtures.en = { kind: "expansion", direction: "ltr" };
    expect(validateLocalizationCoverageManifest(manifest)).toContainEqual({
      path: "testFixtures.en",
      detail: "Release locale IDs cannot be reused as test fixture IDs.",
    });
  });
});
