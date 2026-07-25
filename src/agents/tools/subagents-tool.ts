/**
 * subagents built-in tool.
 *
 * Lists, reads, and cancels background work in the caller's session tree.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { listSkillMemory } from "../../skill-memory/store.sqlite.js";
import { listTaskRecordsUnsorted } from "../../tasks/runtime-internal.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { buildManagedSkillRunResult } from "../managed-skill-result.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  getVisibleSubagentRunById,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagent-control.js";
import { buildSubagentList } from "../subagent-list.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const SUBAGENT_ACTIONS = ["list", "result", "usage", "cancel"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
const MAX_USAGE_RUNS = 100;

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
  runId: Type.Optional(Type.String({ description: "Managed subagent run id" })),
  memoryCursor: Type.Optional(
    Type.Integer({ description: "Cursor from a previous managed result page", minimum: 1 }),
  ),
  runIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Managed subagent run ids to account once each",
      minItems: 1,
      maxItems: MAX_USAGE_RUNS,
    }),
  ),
  maxTokens: Type.Optional(
    Type.Integer({ description: "Optional token ceiling for the selected runs", minimum: 1 }),
  ),
  taskId: Type.Optional(Type.String({ description: "Task id" })),
});

const STATUS_MAP: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

type SubagentsToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  getRun?: (controllerSessionKey: string, runId: string) => SubagentRunRecord | null;
  listRuns?: (controllerSessionKey: string) => SubagentRunRecord[];
  listMemories?: typeof listSkillMemory;
  listTasks?: typeof listTaskRecordsUnsorted;
  cancelTask?: typeof cancelDetachedTaskRunById;
};

async function listManagedRunMemories(
  params: Parameters<typeof listSkillMemory>[0],
): Promise<ReturnType<typeof listSkillMemory>> {
  // Skill Memory SQLite is only needed for explicit result reads; keep ordinary
  // list/cancel tool construction on the lightweight agent path.
  const memoryStore = await import("../../skill-memory/store.sqlite.js");
  return memoryStore.listSkillMemory(params);
}

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function listTreeTasks(tasks: TaskRecord[], rootSessionKey: string): TaskRecord[] {
  const visibleKeys = new Set([rootSessionKey]);
  const visibleTasks = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.scopeKind !== "session" || visibleTasks.has(task.taskId)) {
        continue;
      }
      if (!visibleKeys.has(task.ownerKey)) {
        continue;
      }
      visibleTasks.add(task.taskId);
      if (task.childSessionKey && !visibleKeys.has(task.childSessionKey)) {
        visibleKeys.add(task.childSessionKey);
        changed = true;
      }
    }
  }
  return tasks.filter((task) => visibleTasks.has(task.taskId));
}

function mapTask(task: TaskRecord) {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    status: STATUS_MAP[task.status],
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
  };
}

function addRunUsage(
  total: NonNullable<SubagentRunRecord["usage"]>,
  usage: NonNullable<SubagentRunRecord["usage"]>,
  runTotal: number,
) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoningTokens"] as const) {
    const value = usage[key];
    if (value !== undefined) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
  total.total = (total.total ?? 0) + runTotal;
}

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description: "Background work: subagents, media gen, cron runs. list/result/usage/cancel.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = opts.config ?? getRuntimeConfig();
      const recentMinutesRaw = readPositiveIntegerParam(params, "recentMinutes");
      const recentMinutes =
        recentMinutesRaw === undefined
          ? DEFAULT_RECENT_MINUTES
          : Math.min(MAX_RECENT_MINUTES, recentMinutesRaw);
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      if (action === "result") {
        const runId = readStringParam(params, "runId", { required: true });
        const run = (opts.getRun ?? getVisibleSubagentRunById)(
          controller.controllerSessionKey,
          runId,
        );
        if (!run) {
          return jsonResult({ status: "forbidden", error: "Run outside session tree." });
        }
        const memoryCursor = readPositiveIntegerParam(params, "memoryCursor");
        const memoryParams = {
          filters: { runId },
          limit: 500,
          ...(memoryCursor !== undefined ? { cursor: memoryCursor } : {}),
          store: { cfg },
        };
        const memoryPage = opts.listMemories
          ? opts.listMemories(memoryParams)
          : await listManagedRunMemories(memoryParams);
        const resolution = buildManagedSkillRunResult({
          run,
          memories: memoryPage.memories,
        });
        if (!resolution.ok) {
          return jsonResult({
            status: "error",
            action: "result",
            runId,
            errorCode: resolution.code,
          });
        }
        return jsonResult({
          status: "ok",
          action: "result",
          result: resolution.result,
          ...(memoryPage.nextCursor !== undefined
            ? { memoriesTruncated: true, nextMemoryCursor: memoryPage.nextCursor }
            : {}),
        });
      }

      if (action === "usage") {
        const requestedRunIds = readStringArrayParam(params, "runIds", { required: true });
        const runIds = Array.from(new Set(requestedRunIds));
        if (runIds.length > MAX_USAGE_RUNS) {
          return jsonResult({
            status: "error",
            action: "usage",
            error: `At most ${MAX_USAGE_RUNS} run ids may be accounted at once.`,
          });
        }
        const usage: NonNullable<SubagentRunRecord["usage"]> = {};
        for (const runId of runIds) {
          const run = (opts.getRun ?? getVisibleSubagentRunById)(
            controller.controllerSessionKey,
            runId,
          );
          if (!run) {
            return jsonResult({ status: "forbidden", error: "Run outside session tree." });
          }
          if (!run.managedSkill) {
            return jsonResult({
              status: "accounting_unavailable",
              action: "usage",
              runId,
              reason: "managed_identity_unavailable",
            });
          }
          if (run.endedAt === undefined) {
            return jsonResult({
              status: "accounting_unavailable",
              action: "usage",
              runId,
              reason: "run_not_terminal",
            });
          }
          const runTotal =
            run.usage?.total ??
            (run.usage?.input !== undefined || run.usage?.output !== undefined
              ? (run.usage.input ?? 0) + (run.usage.output ?? 0)
              : undefined);
          if (!run.usage || runTotal === undefined) {
            return jsonResult({
              status: "accounting_unavailable",
              action: "usage",
              runId,
              reason: "usage_unavailable",
            });
          }
          addRunUsage(usage, run.usage, runTotal);
        }
        const maxTokens = readPositiveIntegerParam(params, "maxTokens");
        const totalTokens = usage.total ?? 0;
        return jsonResult({
          status: "ok",
          action: "usage",
          runIds,
          usage,
          ...(maxTokens !== undefined
            ? {
                budget: {
                  maxTokens,
                  remainingTokens: Math.max(0, maxTokens - totalTokens),
                  decision: totalTokens >= maxTokens ? "limit_reached" : "within_limit",
                },
              }
            : {}),
        });
      }

      // The caller only sees subagents controlled by its effective controller session.
      const runs = (opts.listRuns ?? listControlledSubagentRuns)(controller.controllerSessionKey);
      const treeTasks = listTreeTasks(
        (opts.listTasks ?? listTaskRecordsUnsorted)(),
        controller.controllerSessionKey,
      );

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        const cutoff = Date.now() - recentMinutes * 60_000;
        const tasks = treeTasks
          .filter(
            (task) =>
              task.status === "queued" ||
              task.status === "running" ||
              taskUpdatedAt(task) >= cutoff,
          )
          .toSorted((left, right) => taskUpdatedAt(right) - taskUpdatedAt(left))
          .map(mapTask);
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          taskTotal: tasks.length,
          tasks,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "cancel") {
        const taskId = readStringParam(params, "taskId", { required: true });
        const target = treeTasks.find((task) => task.taskId === taskId);
        if (!target) {
          return jsonResult({ status: "forbidden", error: "Task outside session tree." });
        }
        // Leaf subagents may cancel only their own tasks, matching the
        // control-scope gate every other cross-session subagent mutation enforces.
        if (
          controller.controlScope !== "children" &&
          target.ownerKey !== controller.callerSessionKey
        ) {
          return jsonResult({
            status: "forbidden",
            error: "Leaf subagents cannot cancel other sessions.",
          });
        }
        const result = await (opts.cancelTask ?? cancelDetachedTaskRunById)({ cfg, taskId });
        return jsonResult({
          status: result.cancelled ? "cancelled" : "error",
          taskId,
          found: result.found,
          cancelled: result.cancelled,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
