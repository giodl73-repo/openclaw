import { describe, expect, it } from "vitest";
import { addClawControlUiSafetyBlockers } from "./control-ui-safety.js";
import type { ClawDiagnostic, ClawManifest, ClawOpenClawProfile } from "./types.js";

const manifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "assistant" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
};

describe("Claw Control UI admin confirmation", () => {
  it.each<ClawOpenClawProfile | undefined>([
    undefined,
    { schemaVersion: 1, agent: {} },
    {
      schemaVersion: 1,
      agent: { tools: { allow: ["exec"] }, sandbox: { mode: "off", workspaceAccess: "rw" } },
    },
  ])("preserves canonical checks for explicit and inherited permissions", (openClawProfile) => {
    const plan = {
      planIntegrity: "canonical",
      blockers: [
        {
          level: "error",
          phase: "plan",
          code: "workspace_exists",
          path: "$.workspace",
          message: "Workspace already exists.",
        },
      ] as ClawDiagnostic[],
    };
    const result = addClawControlUiSafetyBlockers(plan, { manifest, openClawProfile });
    expect(result).toBe(plan);
  });

  it("keeps plugin consent required and bound to the reviewed plan", () => {
    const plan = { planIntegrity: "canonical", blockers: [] as ClawDiagnostic[] };
    const loaded = {
      manifest: {
        ...manifest,
        packages: [{ kind: "plugin" as const, ref: "@owner/plugin", version: "1.0.0" }],
      },
    };
    const result = addClawControlUiSafetyBlockers(plan, loaded);
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: "plugin_consent_unavailable", path: "$.packages[0]" }),
    ]);
    expect(result.planIntegrity).not.toBe(plan.planIntegrity);
    expect(plan.blockers).toEqual([]);
    expect(addClawControlUiSafetyBlockers(plan, loaded)).toEqual(result);
  });
});
