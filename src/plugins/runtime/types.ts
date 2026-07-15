// Plugin runtime types describe activated plugin capabilities exposed to core execution.
// Owner schema module import keeps the ProtocolSchemas registry out of the
// public plugin-sdk dts graph (check-plugin-sdk-exports guards this).
import type { NodePluginToolDescriptor } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

type PluginRuntimeChannel = import("./types-channel.js").PluginRuntimeChannel;

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  idempotencyKey?: string;
  cwd?: string;
};

type PluginManagedWorktree = {
  id: string;
  path: string;
  branch: string;
};

export type SubagentRunResult = {
  runId: string;
};

type SubagentWaitParams = {
  runId: string;
  /** Include the persisted audit summary for this run when the session is known. */
  sessionKey?: string;
  timeoutMs?: number;
};

export type SubagentRunAudit = {
  auditSchema: "openclaw-audit-run";
  schemaVersion: 1;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  firstEventAt: string;
  lastEventAt: string;
  status?: string;
  models: Array<{ provider?: string; modelId?: string }>;
  usage?: Partial<
    Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoningTokens" | "total", number>
  >;
  cost?: { usd: number; basis: "provider-billed" | "catalog-estimate" | "mixed" };
  skillInvocations: Array<{
    invocationId: string;
    parentInvocationId?: string;
    parentRunId?: string;
    commandName?: string;
    skillName?: string;
    skillSource?: string;
    skillDigest?: string;
    executionHints?: Record<string, unknown>;
    status?: string;
  }>;
  skills: Array<{
    skillName: string;
    skillSource?: string;
    activation?: string;
    toolName?: string;
    toolCallId?: string;
  }>;
  receipts: Array<Record<string, unknown>>;
};

type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
  audit?: SubagentRunAudit;
};

type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

type RuntimeNodeListParams = {
  connected?: boolean;
};

type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
    caps?: string[];
    commands?: string[];
    /** Advertised commands currently permitted by Gateway node-command policy. */
    invocableCommands?: string[];
    nodePluginTools?: NodePluginToolDescriptor[];
  }>;
};

type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

export type RuntimeGatewayRequestOptions = {
  timeoutMs?: number;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

export type RuntimeToolInvokeParams = {
  name: string;
  action?: string;
  args?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type RuntimeToolInvokeResult =
  | {
      ok: true;
      toolName: string;
      output: unknown;
      source: "core" | "plugin" | "channel";
    }
  | {
      ok: false;
      toolName: string;
      requiresApproval?: boolean;
      error: { code: string; message: string };
    };

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  gateway: {
    /** Whether this process owns an active Gateway request context. */
    isAvailable: () => Promise<boolean>;
    /** Dispatch a Gateway method as the current trusted plugin. */
    request: <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
  };
  tools: {
    /** Invoke a tool under the trusted policy context of the current plugin tool call. */
    invoke: (
      context: OpenClawPluginToolContext,
      params: RuntimeToolInvokeParams,
    ) => Promise<RuntimeToolInvokeResult>;
  };
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
  };
  worktrees: {
    create: (params: {
      repoRoot: string;
      name: string;
      baseRef?: string;
      ownerKind: "workboard";
      ownerId: string;
    }) => Promise<PluginManagedWorktree>;
    release: (params: { path: string }) => Promise<void>;
    removeIfLossless: (params: { path: string }) => Promise<boolean>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  allowGatewaySubagentBinding?: boolean;
};
