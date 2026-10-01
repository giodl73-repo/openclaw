import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";

describe("Claw update current-request authority", () => {
  it.each(["planning", "workspace", "cron"] as const)(
    "stops forward writes after authority is lost during %s and preserves rollback",
    async (phase) => {
      const updatePlan = plan([]);
      let current = true;
      const beforePersistentApply = () => {
        if (!current) {
          throw new Error("Browser request is no longer current.");
        }
      };
      const workspaceRollback = vi.fn(async () => undefined);
      const mcpRollback = vi.fn(async () => undefined);
      const cronRollback = vi.fn(async () => undefined);
      const applyWorkspace = vi.fn(async () => {
        await Promise.resolve();
        current = phase !== "workspace";
        return { appliedPaths: [], rollback: workspaceRollback };
      });
      const applyMcp = vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback }));
      const applyCron = vi.fn(async () => {
        await Promise.resolve();
        current = phase !== "cron";
        return { appliedIds: [], rollback: cronRollback };
      });
      const persistInstall = vi.fn(() => install);

      await expect(
        applyClawUpdatePlan(
          updatePlan,
          { targetManifest: manifest, targetSource: source },
          {
            config: {},
            ...consent(updatePlan),
            beforePersistentApply,
            rebuildPlan: async () => updatePlan,
            readInstall: () => install,
            buildAddPlan: async () => {
              await Promise.resolve();
              current = phase !== "planning";
              return addPlan;
            },
            applyWorkspace,
            applyMcp,
            applyCron,
            persistInstall,
          },
        ),
      ).rejects.toThrow("Browser request is no longer current.");

      expect(persistInstall).not.toHaveBeenCalled();
      if (phase === "planning") {
        expect(applyWorkspace).not.toHaveBeenCalled();
        expect(workspaceRollback).not.toHaveBeenCalled();
      } else {
        expect(applyWorkspace).toHaveBeenCalledWith(
          updatePlan,
          addPlan,
          expect.objectContaining({ beforePersistentApply }),
        );
        expect(workspaceRollback).toHaveBeenCalledOnce();
      }
      if (phase === "cron") {
        expect(mcpRollback).toHaveBeenCalledOnce();
        expect(cronRollback).toHaveBeenCalledOnce();
      } else {
        expect(applyMcp).not.toHaveBeenCalled();
        expect(applyCron).not.toHaveBeenCalled();
      }
    },
  );

  it("passes live authority to the config commit and allows owned rollback after revocation", async () => {
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
      },
    ]);
    const initialConfig: OpenClawConfig = {
      agents: { entries: { worker: { name: "Worker" } } },
    };
    let config = initialConfig;
    let current = true;
    const beforePersistentApply = () => {
      if (!current) {
        throw new Error("Browser request is no longer current.");
      }
    };
    const commitConfig = vi.fn<
      NonNullable<Parameters<typeof applyClawUpdatePlan>[2]["commitConfig"]>
    >(async (transform, guard) => {
      guard?.();
      config = transform(config);
      if (guard) {
        await Promise.resolve();
        current = false;
      }
    });
    const applyCron = vi.fn();
    const persistInstall = vi.fn(() => install);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          beforePersistentApply,
          rebuildPlan: async () => updatePlan,
          buildAddPlan: async () => addPlan,
          readInstall: () => install,
          commitConfig,
          applyCron,
          persistInstall,
        },
      ),
    ).rejects.toThrow("Browser request is no longer current.");

    expect(commitConfig).toHaveBeenNthCalledWith(1, expect.any(Function), beforePersistentApply);
    expect(commitConfig).toHaveBeenNthCalledWith(2, expect.any(Function));
    expect(config).toEqual(initialConfig);
    expect(applyCron).not.toHaveBeenCalled();
    expect(persistInstall).not.toHaveBeenCalled();
  });
});
