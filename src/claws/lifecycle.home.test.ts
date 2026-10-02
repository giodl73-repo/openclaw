import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["OPENCLAW_HOME", "HOME"] as const)(
  "resolves the default workspace from %s while preserving an explicit workspace",
  async (homeKey) => {
    const root = await realpath(tempDirs.make("openclaw-claw-home-"));
    const home = join(root, "home");
    const workspace = join(root, "explicit-workspace");
    const parsed = parseClawManifest({ schemaVersion: 1, agent: { id: "home-proof" } });
    if (!parsed.ok) {
      throw new Error("Expected the fixture manifest to parse");
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: "home-proof",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    };
    await withEnvAsync({ OPENCLAW_HOME: undefined, [homeKey]: home }, async () => {
      const plan = await buildClawAddPlan({ manifest: parsed.manifest, source });
      expect(plan.agent.workspace).toBe(join(home, ".openclaw", "workspace-home-proof"));
      const explicit = await buildClawAddPlan({
        manifest: parsed.manifest,
        source,
        context: { workspace },
      });
      expect(explicit.agent.workspace).toBe(workspace);
    });
  },
);
