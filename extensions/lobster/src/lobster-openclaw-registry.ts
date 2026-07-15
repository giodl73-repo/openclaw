// In-process Lobster command bridge for invoking policy-filtered OpenClaw tools.

type JsonRecord = Record<string, unknown>;

type LobsterCommandContext = {
  env: Record<string, string | undefined>;
};

type LobsterCommandRunParams = {
  input: AsyncIterable<unknown>;
  args: JsonRecord;
  ctx: LobsterCommandContext;
};

type LobsterCommand = {
  name: string;
  meta?: JsonRecord;
  help?: () => string;
  run: (params: LobsterCommandRunParams) => Promise<{ output: AsyncIterable<unknown> }>;
};

export type LobsterCommandRegistry = {
  get(name: string): LobsterCommand | undefined;
  list(): string[];
};

export type EmbeddedOpenClawInvoke = (params: {
  tool: string;
  action?: string;
  args: JsonRecord;
  idempotencyKey?: string;
}) => Promise<unknown>;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: unknown, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function resolveStepIdempotencyKey(args: JsonRecord, ctx: LobsterCommandContext) {
  const explicitIdempotencyKey = readOptionalString(args.idempotencyKey ?? args["idempotency-key"]);
  const flowId = readOptionalString(ctx.env.OPENCLAW_TASK_FLOW_ID);
  const stepId = readOptionalString(args.stepId ?? args["step-id"]);
  return explicitIdempotencyKey ?? (flowId && stepId ? `lobster:${flowId}:${stepId}` : undefined);
}

function parseArgsJson(value: unknown): JsonRecord {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error("openclaw.invoke --args-json must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("openclaw.invoke --args-json must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openclaw.invoke --args-json must contain a JSON object");
  }
  return parsed as JsonRecord;
}

async function* outputItems(value: unknown): AsyncIterable<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield item;
    }
    return;
  }
  yield value;
}

function createInvokeCommand(invoke: EmbeddedOpenClawInvoke): LobsterCommand {
  return {
    name: "openclaw.invoke",
    meta: {
      description: "Invoke an OpenClaw tool in process with the current session and tool policy",
      sideEffects: ["calls_openclaw_tool"],
    },
    help: () =>
      "openclaw.invoke --tool <name> --action <action> [--args-json '{...}'] [--step-id <id>]",
    async run({ input, args, ctx }) {
      const tool = readOptionalString(args.tool);
      const action = readOptionalString(args.action);
      if (!tool || !action) {
        throw new Error("openclaw.invoke requires --tool and --action");
      }
      if (tool === "lobster") {
        throw new Error("openclaw.invoke cannot recursively invoke the lobster tool");
      }
      const each = args.each === true;
      const itemKey = readOptionalString(args.itemKey ?? args["item-key"]) ?? "item";
      const baseArgs = parseArgsJson(args["args-json"]);
      if (readOptionalString(args.sessionKey ?? args["session-key"])) {
        throw new Error("embedded openclaw.invoke always uses the current OpenClaw session");
      }
      const idempotencyKey = resolveStepIdempotencyKey(args, ctx);

      const invokeOnce = async (toolArgs: JsonRecord, itemIndex?: number) =>
        await invoke({
          tool,
          action,
          args: toolArgs,
          idempotencyKey:
            idempotencyKey && itemIndex !== undefined
              ? `${idempotencyKey}:${itemIndex}`
              : idempotencyKey,
        });
      if (!each) {
        for await (const item of input) {
          // Inline invocations do not implicitly forward pipeline input.
          void item;
        }
        return { output: outputItems(await invokeOnce(baseArgs)) };
      }

      const output: unknown[] = [];
      let itemIndex = 0;
      for await (const item of input) {
        const result = await invokeOnce({ ...baseArgs, [itemKey]: item }, itemIndex);
        itemIndex += 1;
        if (Array.isArray(result)) {
          output.push(...result);
        } else {
          output.push(result);
        }
      }
      return { output: outputItems(output) };
    },
  };
}

function createSkillCommand(invoke: EmbeddedOpenClawInvoke): LobsterCommand {
  return {
    name: "openclaw.skill",
    meta: {
      description: "Run an available OpenClaw skill as a managed child step",
      sideEffects: ["spawns_managed_skill"],
    },
    help: () =>
      "openclaw.skill --skill <name> --task <task> [--token-budget <tokens>] [--model <model>] [--task-name <name>] [--step-id <id>]",
    async run({ input, args, ctx }) {
      for await (const item of input) {
        // Skill steps are explicit and do not implicitly consume pipeline input.
        void item;
      }
      const skill = readOptionalString(args.skill);
      const task = readOptionalString(args.task);
      if (!skill || !task) {
        throw new Error("openclaw.skill requires --skill and --task");
      }
      if (readOptionalString(args.sessionKey ?? args["session-key"])) {
        throw new Error("embedded openclaw.skill always uses the current OpenClaw session");
      }
      const tokenBudget = readOptionalPositiveInteger(
        args.tokenBudget ?? args["token-budget"],
        "openclaw.skill --token-budget",
      );
      const model = readOptionalString(args.model);
      const taskName = readOptionalString(args.taskName ?? args["task-name"]);
      const result = await invoke({
        tool: "sessions_spawn",
        args: {
          task,
          skill,
          runtime: "subagent",
          mode: "run",
          ...(tokenBudget ? { tokenBudget } : {}),
          ...(model ? { model } : {}),
          ...(taskName ? { taskName } : {}),
        },
        idempotencyKey: resolveStepIdempotencyKey(args, ctx),
      });
      return { output: outputItems(result) };
    },
  };
}

/** Adds OpenClaw-owned bridges; every other Lobster command stays package-owned. */
export function createOpenClawLobsterRegistry(
  base: LobsterCommandRegistry,
  invoke: EmbeddedOpenClawInvoke,
): LobsterCommandRegistry {
  const invokeCommand = createInvokeCommand(invoke);
  const skillCommand = createSkillCommand(invoke);
  return {
    get(name) {
      if (name === invokeCommand.name || name === "clawd.invoke") {
        return invokeCommand;
      }
      if (name === skillCommand.name || name === "clawd.skill") {
        return skillCommand;
      }
      return base.get(name);
    },
    list() {
      return [
        ...new Set([
          ...base.list(),
          "openclaw.invoke",
          "clawd.invoke",
          "openclaw.skill",
          "clawd.skill",
        ]),
      ].toSorted();
    },
  };
}
