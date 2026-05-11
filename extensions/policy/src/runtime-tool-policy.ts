import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { parseOcDocument, type Diagnostic, type JsoncAst } from "@openclaw/oc-path/api.js";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { jsoncValueToUnknown } from "./jsonc-value.js";
import {
  collectPolicyEvidence,
  policyDocumentHash,
  type PolicyEvidence,
  type PolicyToolEvidence,
} from "./policy-state.js";

type PolicyRuntimeSettings = {
  readonly enabled?: boolean;
  readonly runtimeToolPolicy?: boolean;
  readonly requireRisk?: boolean;
  readonly requireSensitivity?: boolean;
  readonly expectedHash?: string;
  readonly path?: string;
};

type RuntimePolicyState = {
  readonly policyPath: string;
  readonly policyHash?: string;
  readonly policy?: unknown;
  readonly evidence: PolicyEvidence;
  readonly settings: PolicyRuntimeSettings;
};

type RuntimePolicyDeps = {
  readonly readConfig?: () => OpenClawConfig;
  readonly cwd?: string;
  readonly resolveWorkspaceDir?: (cfg: OpenClawConfig, ctx: PolicyToolContext) => string;
};

type PolicyToolEvent = {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
};

type PolicyToolContext = {
  readonly agentId?: string;
  readonly workspaceDir?: string;
};

export function registerPolicyTrustedToolPolicy(
  api: Pick<OpenClawPluginApi, "config" | "registerTrustedToolPolicy" | "runtime">,
  deps: RuntimePolicyDeps = {},
): void {
  api.registerTrustedToolPolicy({
    id: "policy-tool-runtime",
    description: "Apply enabled policy tool requirements before tool calls.",
    async evaluate(event, ctx) {
      return evaluatePolicyTrustedToolCall(event, ctx, {
        cwd: deps.cwd,
        readConfig:
          deps.readConfig ??
          (() => (api.runtime.config?.current?.() as OpenClawConfig | undefined) ?? api.config),
        resolveWorkspaceDir:
          deps.resolveWorkspaceDir ??
          ((cfg, context) => {
            const agentId = context.agentId ?? resolveDefaultAgentId(cfg);
            return (
              context.workspaceDir ?? api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)
            );
          }),
      });
    },
  });
}

export async function evaluatePolicyTrustedToolCall(
  event: PolicyToolEvent,
  ctx: PolicyToolContext,
  deps: RuntimePolicyDeps = {},
) {
  const cfg = deps.readConfig?.();
  if (cfg === undefined) {
    return undefined;
  }
  const settings = policySettings(cfg);
  if (settings.enabled !== true) {
    return undefined;
  }
  if (settings.runtimeToolPolicy !== true) {
    return undefined;
  }

  const workspaceDir = deps.cwd ?? deps.resolveWorkspaceDir?.(cfg, ctx);
  if (workspaceDir === undefined) {
    return undefined;
  }
  const state = await loadRuntimePolicyState(cfg, settings, workspaceDir);

  const expectedHash = state.settings.expectedHash;
  if (state.policy === undefined) {
    return {
      block: true,
      blockReason: `Policy tool runtime is enabled, but ${state.policyPath} is missing.`,
    };
  }
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    state.policyHash !== expectedHash.trim()
  ) {
    return {
      block: true,
      blockReason: `${state.policyPath} does not match the configured policy hash.`,
    };
  }

  const tool = state.evidence.tools.find((entry) => entry.id === event.toolName);
  if (tool === undefined) {
    if (toolMetadataRequired(state)) {
      return {
        requireApproval: {
          title: "Review undeclared tool",
          description: `Policy requires tool metadata, but '${event.toolName}' is not declared in TOOLS.md.`,
          severity: "warning" as const,
          allowedDecisions: ["allow-once", "deny"] as const,
        },
      };
    }
    return undefined;
  }

  const metadataBlockReason = toolMetadataBlockReason(tool, state);
  if (metadataBlockReason !== undefined) {
    return {
      block: true,
      blockReason: metadataBlockReason,
    };
  }

  const approvalReason = toolApprovalReason(tool);
  if (approvalReason === undefined) {
    return undefined;
  }
  return {
    requireApproval: {
      title: "Review policy-governed tool",
      description: `${event.toolName} requires approval because ${approvalReason}.`,
      severity: tool.risk === "critical" ? ("critical" as const) : ("warning" as const),
      allowedDecisions: ["allow-once", "deny"] as const,
    },
  };
}

async function loadRuntimePolicyState(
  cfg: OpenClawConfig,
  settings: PolicyRuntimeSettings,
  cwd: string,
): Promise<RuntimePolicyState> {
  const policyPath = policyDisplayName(settings);
  const toolsRaw = await readFileIfExists(resolve(cwd, "TOOLS.md"));
  const evidence = collectPolicyEvidence(
    cfg as Record<string, unknown>,
    toolsRaw === null ? {} : { toolsRaw },
  );
  const policyRaw = await readFileIfExists(resolveWorkspacePath(cwd, policyPathSetting(settings)));
  if (policyRaw === null) {
    return { policyPath, evidence, settings };
  }
  const parsed = parsePolicyFile(policyRaw, policyPath);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { policyPath, evidence, settings };
  }
  const policy = parsed.ast.root === null ? {} : jsoncValueToUnknown(parsed.ast.root);
  return {
    policyPath,
    policy,
    policyHash: policyDocumentHash(policy),
    evidence,
    settings,
  };
}

function toolMetadataRequired(state: RuntimePolicyState): boolean {
  return requireRisk(state) || requireSensitivity(state);
}

function toolMetadataBlockReason(tool: PolicyToolEvidence, state: RuntimePolicyState): string | undefined {
  if (requireRisk(state) && tool.risk === undefined) {
    return `Policy requires risk metadata for '${tool.id}', but TOOLS.md does not declare it.`;
  }
  if (requireSensitivity(state)) {
    if (tool.sensitivity === undefined) {
      return `Policy requires sensitivity metadata for '${tool.id}', but TOOLS.md does not declare it.`;
    }
    if (!["public", "internal", "confidential", "restricted"].includes(tool.sensitivity)) {
      return `Policy requires known sensitivity metadata for '${tool.id}', but TOOLS.md declares '${tool.sensitivity}'.`;
    }
  }
  return undefined;
}

function requireRisk(state: RuntimePolicyState): boolean {
  return (
    state.settings.requireRisk === true ||
    readPolicyBoolean(state.policy, ["tools", "settings", "requireRisk"]) === true
  );
}

function requireSensitivity(state: RuntimePolicyState): boolean {
  return (
    state.settings.requireSensitivity === true ||
    readPolicyBoolean(state.policy, ["tools", "settings", "requireSensitivity"]) === true
  );
}

function toolApprovalReason(tool: PolicyToolEvidence): string | undefined {
  const reasons: string[] = [];
  if (tool.risk === "critical") {
    reasons.push("risk is critical");
  }
  if (tool.capabilities?.includes("IRREVERSIBLE_EXTERNAL")) {
    reasons.push("it can perform irreversible external actions");
  }
  return reasons.length === 0 ? undefined : reasons.join(" and ");
}

function policySettings(cfg: OpenClawConfig): PolicyRuntimeSettings {
  const pluginConfig = cfg.plugins?.entries?.policy?.config;
  return isRecord(pluginConfig) ? pluginConfig : {};
}

function policyPathSetting(settings: PolicyRuntimeSettings): string {
  return typeof settings.path === "string" && settings.path.trim() !== ""
    ? settings.path.trim()
    : "policy.jsonc";
}

function policyDisplayName(settings: PolicyRuntimeSettings): string {
  const configured = policyPathSetting(settings);
  return isAbsolute(configured) ? basename(configured) : configured;
}

function resolveWorkspacePath(cwd: string, fileName: string): string {
  return isAbsolute(fileName) ? fileName : resolve(cwd, fileName);
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function parsePolicyFile(
  raw: string,
  fileName: string,
): {
  readonly ast: JsoncAst;
  readonly diagnostics: readonly Diagnostic[];
} {
  const parsed = parseOcDocument(raw, { fileName });
  if (parsed.ast.kind !== "jsonc") {
    throw new Error(`${fileName} did not parse as jsonc.`);
  }
  return { ast: parsed.ast, diagnostics: parsed.diagnostics };
}

function readPolicyBoolean(policy: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
