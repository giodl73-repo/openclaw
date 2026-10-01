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

describe("Claw Control UI disclosure gate", () => {
  it.each<ClawOpenClawProfile | undefined>([
    undefined,
    { schemaVersion: 1, agent: {} },
    {
      schemaVersion: 1,
      agent: { tools: { allow: ["exec"] }, sandbox: { mode: "off", workspaceAccess: "rw" } },
    },
  ])("blocks both explicit and inherited permissions without disclosure", (openClawProfile) => {
    const plan = { planIntegrity: "canonical", blockers: [] as ClawDiagnostic[] };
    const result = addClawControlUiSafetyBlockers(plan, { manifest, openClawProfile });
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "capability_disclosure_unavailable" }),
    );
    expect(result.planIntegrity).not.toBe(plan.planIntegrity);
    expect(plan.blockers).toEqual([]);
    expect(addClawControlUiSafetyBlockers(plan, { manifest, openClawProfile })).toEqual(result);
  });
});
