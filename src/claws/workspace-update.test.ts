import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { applyClawWorkspaceUpdate } from "./workspace-update.js";
import { readClawWorkspaceFiles } from "./workspace.js";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("applyClawWorkspaceUpdate", () => {
  it("does not publish a workspace file when request authority expires during its source read", async () => {
    const root = tempDirs.make("claw-workspace-authority-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "NEW.md"), "new\n");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: { files: [{ source: "NEW.md", path: "NEW.md" }] },
    });
    if (!parsed.ok) {
      throw new Error("Invalid fixture manifest.");
    }
    const target = await buildClawAddPlan({
      manifest: parsed.manifest,
      source: {
        kind: "package",
        name: "@synthetic/worker",
        version: "2.0.0",
        packageRoot: root,
        manifestPath: join(root, "CLAW.md"),
        integrityKind: "artifact",
        integrity: "sha256:target",
        byteLength: 1,
      },
      context: { workspace },
    });
    const targetFile = target.actions.find((action) => action.kind === "workspaceFile");
    expect(targetFile?.digest).toBeDefined();
    let authorized = true;
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence: async () => {
        await Promise.resolve();
        authorized = false;
      },
    });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    await expect(
      applyClawWorkspaceUpdate(
        createClawUpdatePlanFixture([
          {
            kind: "workspaceFile",
            id: "NEW.md",
            action: "add",
            target: join(workspace, "NEW.md"),
            blocked: false,
            reason: "added",
            desiredDigest: targetFile?.digest,
          },
        ]),
        target,
        {
          env,
          beforePersistentApply: () => {
            if (!authorized) {
              throw new Error("Request revoked.");
            }
          },
        },
      ),
    ).rejects.toThrow("Request revoked.");

    expect(authorized).toBe(false);
    await expect(access(join(workspace, "NEW.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([]);
  });

  it("applies add/change/remove actions and can roll them back with provenance", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-update-");
    const currentRoot = join(root, "current");
    const targetRoot = join(root, "target");
    await mkdir(currentRoot);
    await mkdir(targetRoot);
    await writeFile(join(currentRoot, "SOUL.md"), "current soul\n", "utf8");
    await writeFile(join(currentRoot, "OLD.md"), "old\n", "utf8");
    const targetSoul = Buffer.from("target soul\n");
    await writeFile(
      join(targetRoot, "CLAW.md"),
      Buffer.concat([
        Buffer.from("---\nschemaVersion: 1\nagent: { id: worker }\n---\n"),
        targetSoul,
      ]),
    );
    await writeFile(join(targetRoot, "NEW.md"), "new\n", "utf8");

    const currentParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
        files: [{ source: "OLD.md", path: "OLD.md" }],
      },
    });
    const targetParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        files: [{ source: "NEW.md", path: "NEW.md" }],
      },
    });
    if (!currentParsed.ok || !targetParsed.ok) {
      throw new Error("fixture manifest invalid");
    }
    const currentSource: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: currentRoot,
      manifestPath: join(currentRoot, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:current",
      byteLength: 1,
    };
    const targetSource: ClawSourceIdentity = {
      ...currentSource,
      version: "2.0.0",
      packageRoot: targetRoot,
      manifestPath: join(targetRoot, "CLAW.md"),
      integrity: "sha256:target",
    };
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const currentAddPlan = await buildClawAddPlan({
      manifest: currentParsed.manifest,
      source: currentSource,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(currentAddPlan, {
      env,
      nowMs: 10,
      consentPlanIntegrity: currentAddPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const originalFiles = readClawWorkspaceFiles("worker", { env });
    const updatePlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: targetParsed.manifest,
      targetClawMarkdownBody: targetSoul,
      targetSource,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    const targetAddPlan = await buildClawAddPlan({
      manifest: targetParsed.manifest,
      clawMarkdownBody: targetSoul,
      source: targetSource,
      context: { agentId: "worker", workspace },
    });
    expect(JSON.stringify(updatePlan)).not.toContain("target soul");

    const execution = await applyClawWorkspaceUpdate(updatePlan, targetAddPlan, {
      env,
      nowMs: 20,
    });

    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("target soul\n");
    await expect(readFile(join(workspace, "NEW.md"), "utf8")).resolves.toBe("new\n");
    await expect(access(join(workspace, "OLD.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([
      expect.objectContaining({ path: "NEW.md", sourcePath: "NEW.md" }),
      expect.objectContaining({ path: "SOUL.md", sourcePath: "CLAW.md" }),
    ]);

    await execution.rollback();

    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("current soul\n");
    await expect(readFile(join(workspace, "OLD.md"), "utf8")).resolves.toBe("old\n");
    await expect(access(join(workspace, "NEW.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual(originalFiles);

    await rm(join(workspace, "OLD.md"));
    await expect(
      applyClawWorkspaceUpdate(updatePlan, targetAddPlan, { env, nowMs: 30 }),
    ).rejects.toThrow("disappeared after planning");
  });
});
