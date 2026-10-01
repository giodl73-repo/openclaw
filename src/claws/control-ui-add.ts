import { resolve } from "node:path";
import type {
  ClawsAddApplyParams,
  ClawLifecycleApplyResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { applyClawAddPlan } from "./add.js";
import { withResolvedClawHubSource } from "./clawhub-source.js";
import { buildClawControlUiAddPlan, projectClawAddPlan } from "./control-ui-plan.js";
import type { ClawCronGateway } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import { clawContainedRelativePath } from "./path-containment.js";
import { withClawMutationGuard } from "./state-write.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";

// Only planner-authored source references are relocated. Manifest strings and destinations are not.
export function materializeClawAddSource(
  plan: ClawAddPlan,
  source: ClawSourceIdentity,
): ClawAddPlan {
  const sourcePath = (value: string): string => {
    if (!value.startsWith("$CLAW_SOURCE/")) {
      throw new Error("Claw source reference is not canonical.");
    }
    const relative = value.slice("$CLAW_SOURCE/".length);
    if (!relative || relative.split(/[\\/]/u).some((part) => part === "..")) {
      throw new Error("Claw source reference escapes its package.");
    }
    const target = resolve(source.packageRoot, relative);
    if (!clawContainedRelativePath(resolve(source.packageRoot), target)) {
      throw new Error("Claw source reference escapes its package.");
    }
    return target;
  };
  return {
    ...plan,
    claw: source,
    actions: plan.actions.map((action) =>
      action.source && (action.kind === "workspaceFile" || action.kind === "bootstrap")
        ? { ...action, source: sourcePath(action.source) }
        : action,
    ),
  };
}

export async function applyClawAddFromCatalog(
  params: ClawsAddApplyParams & {
    getRuntimeConfig: () => OpenClawConfig;
    assertCurrent: () => void;
    signal?: AbortSignal;
    cronGateway: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
  },
): Promise<ClawLifecycleApplyResult> {
  params.assertCurrent();
  let settledResult: ClawLifecycleApplyResult | undefined;
  const partialMessage = "Claw add is incomplete. Review Claws status and doctor before retrying.";
  try {
    const resolved = await withResolvedClawHubSource({
      coordinate: params.source,
      mode: "apply",
      acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
      run: async (loaded, trust, persistSource) => {
        const inventory = await readClawInventory();
        params.assertCurrent();
        const initialConfig = params.getRuntimeConfig();
        const initial = await buildClawControlUiAddPlan({
          loaded,
          inventory,
          config: initialConfig,
          agentId: params.agentId,
        });
        const checkConsent = (plan: ClawAddPlan, config: OpenClawConfig) => {
          params.assertCurrent();
          if (projectClawAddPlan(plan, trust, config).planIntegrity !== params.planIntegrity) {
            throw new Error("Claw add consent changed; preview it again.");
          }
          if (plan.blockers.length || plan.actions.some((action) => action.blocked)) {
            throw new Error("Claw add plan is blocked.");
          }
        };
        checkConsent(initial, initialConfig);
        // Share the deletion owner's cross-process fence; an add cannot race agent cleanup.
        return withOpenClawStateLease(
          {
            scope: "core:agent-deletion",
            key: initial.agent.finalId,
            database: { scope: "shared", options: {} },
            leaseMs: 60_000,
            waitMs: 5_000,
            heartbeat: "worker",
            signal: params.signal,
            leaseLabel: "Claw add",
            operationLabel: "claw.add.lease",
          },
          async (lease) => {
            const assertCurrent = () => {
              params.assertCurrent();
              lease.assertOwned();
            };
            return withClawMutationGuard(assertCurrent, async () => {
              const freshInventory = await readClawInventory();
              assertCurrent();
              const config = params.getRuntimeConfig();
              const configIntegrity = digestClawValue(config);
              const assertConfigCurrent = () => {
                assertCurrent();
                if (digestClawValue(params.getRuntimeConfig()) !== configIntegrity) {
                  throw new Error("OpenClaw config changed; preview the Claw again.");
                }
              };
              const fresh = await buildClawControlUiAddPlan({
                loaded,
                inventory: freshInventory,
                config,
                agentId: initial.agent.finalId,
              });
              checkConsent(fresh, config);
              assertConfigCurrent();
              const persisted = await persistSource();
              assertConfigCurrent();
              const persistedPlan = await buildClawControlUiAddPlan({
                loaded: persisted,
                inventory: freshInventory,
                config,
                agentId: initial.agent.finalId,
                physicalSource: true,
              });
              assertConfigCurrent();
              const expected = materializeClawAddSource(fresh, persisted.source);
              const { planIntegrity: _expectedIntegrity, ...expectedBody } = expected;
              const { planIntegrity: _actualIntegrity, ...actualBody } = persistedPlan;
              if (digestClawValue(expectedBody) !== digestClawValue(actualBody)) {
                throw new Error("Claw source or state changed; preview it again.");
              }
              const executable = persistedPlan;
              let configMutationStarted = false;
              const result = await withClawMutationGuard(
                () => {
                  assertCurrent();
                  if (!configMutationStarted) {
                    assertConfigCurrent();
                  }
                },
                () =>
                  applyClawAddPlan(executable, {
                    consentPlanIntegrity: executable.planIntegrity,
                    cronGateway: params.cronGateway,
                    commitConfig: async (transform) => {
                      await transformConfigFileWithRetry({
                        afterWrite: { mode: "auto" },
                        writeOptions: { assertCurrent },
                        transform: (current) => {
                          assertConfigCurrent();
                          configMutationStarted = true;
                          return { nextConfig: transform(current) };
                        },
                      });
                    },
                  }),
              );
              settledResult = {
                schemaVersion: "openclaw.clawsGatewayApply.v1",
                operation: "add",
                status: result.status,
                agentId: result.agent.finalId,
                message: result.status === "complete" ? "Claw added." : partialMessage,
              } satisfies ClawLifecycleApplyResult;
              return settledResult;
            });
          },
        );
      },
    });
    return resolved.value;
  } catch (error) {
    if (!settledResult) {
      throw error;
    }
    // Lease settlement or source cleanup can fail after mutation has already settled.
    return { ...settledResult, status: "partial", message: partialMessage };
  }
}
