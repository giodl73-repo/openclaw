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
  action: string;
  args: JsonRecord;
  sessionKey?: string;
  idempotencyKey?: string;
}) => Promise<unknown>;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
      const sessionKey =
        readOptionalString(args.sessionKey ?? args["session-key"]) ??
        readOptionalString(ctx.env.OPENCLAW_SESSION_KEY);
      const explicitIdempotencyKey = readOptionalString(
        args.idempotencyKey ?? args["idempotency-key"],
      );
      const flowId = readOptionalString(ctx.env.OPENCLAW_TASK_FLOW_ID);
      const stepId = readOptionalString(args.stepId ?? args["step-id"]);
      const idempotencyKey =
        explicitIdempotencyKey ?? (flowId && stepId ? `lobster:${flowId}:${stepId}` : undefined);

      const invokeOnce = async (toolArgs: JsonRecord) =>
        await invoke({ tool, action, args: toolArgs, sessionKey, idempotencyKey });
      if (!each) {
        for await (const item of input) {
          // Inline invocations do not implicitly forward pipeline input.
          void item;
        }
        return { output: outputItems(await invokeOnce(baseArgs)) };
      }

      const output: unknown[] = [];
      for await (const item of input) {
        const result = await invokeOnce({ ...baseArgs, [itemKey]: item });
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

/** Overrides only openclaw.invoke; every other Lobster command stays package-owned. */
export function createOpenClawLobsterRegistry(
  base: LobsterCommandRegistry,
  invoke: EmbeddedOpenClawInvoke,
): LobsterCommandRegistry {
  const command = createInvokeCommand(invoke);
  return {
    get(name) {
      return name === command.name || name === "clawd.invoke" ? command : base.get(name);
    },
    list() {
      return [...new Set([...base.list(), "openclaw.invoke", "clawd.invoke"])].toSorted();
    },
  };
}
