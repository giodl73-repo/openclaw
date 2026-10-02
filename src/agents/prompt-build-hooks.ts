import type { HookRunner } from "../plugins/hooks.js";
import type { PluginHookAgentContext, PluginHookBeforePromptBuildEvent } from "../plugins/types.js";

type PromptBuildHookRunner = Pick<HookRunner, "runBeforePromptBuild"> &
  Partial<Pick<HookRunner, "runHeartbeatPromptContribution">> & {
    hasHooks: (name: "heartbeat_prompt_contribution" | "before_prompt_build") => boolean;
  };

/** Shared ordering only; callers retain preparation, tool authority, and prompt assembly. */
export async function runPromptBuildHookSequence(params: {
  hookRunner?: PromptBuildHookRunner | null;
  event: PluginHookBeforePromptBuildEvent;
  ctx: PluginHookAgentContext;
  warn: (message: string) => void;
  // External prompt preparation captures presence before asynchronously loading history.
  presenceSnapshot?: { heartbeat: boolean; beforePromptBuild: boolean };
}) {
  const { hookRunner, ctx } = params;
  const hasHeartbeat =
    params.presenceSnapshot?.heartbeat ??
    (ctx.trigger === "heartbeat" &&
      Boolean(hookRunner?.runHeartbeatPromptContribution) &&
      Boolean(hookRunner?.hasHooks("heartbeat_prompt_contribution")));
  const heartbeatResult =
    hasHeartbeat && hookRunner?.runHeartbeatPromptContribution
      ? await hookRunner
          .runHeartbeatPromptContribution(
            {
              sessionKey: ctx.sessionKey,
              agentId: ctx.agentId,
              heartbeatName: "heartbeat",
            },
            ctx,
          )
          .catch((error: unknown) => {
            params.warn(`heartbeat_prompt_contribution hook failed: ${String(error)}`);
            return undefined;
          })
      : undefined;

  // The embedded path checks current presence after heartbeat settlement.
  const hasPromptBuild =
    params.presenceSnapshot?.beforePromptBuild ??
    Boolean(hookRunner?.hasHooks("before_prompt_build"));
  const promptBuildResult =
    hasPromptBuild && hookRunner
      ? await hookRunner.runBeforePromptBuild(params.event, ctx).catch((error: unknown) => {
          params.warn(`before_prompt_build hook failed: ${String(error)}`);
          return undefined;
        })
      : undefined;

  return { heartbeatResult, promptBuildResult };
}
