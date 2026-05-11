import { basename, isAbsolute, resolve } from "node:path";
import {
  parseOcDocument,
  parseOcPath,
  resolveOcPath,
  type Diagnostic,
  type JsoncAst,
} from "@openclaw/oc-path/api.js";
import {
  registerHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { jsoncValueToUnknown } from "../jsonc-value.js";
import {
  collectPolicyEvidence,
  policyDocumentHash,
  type PolicyEvidence,
} from "../policy-state.js";

const CHECK_IDS = {
  policyDeniedChannelProvider: "policy/channels-denied-provider",
  policyHashMismatch: "policy/policy-hash-mismatch",
  policyMissingFile: "policy/policy-jsonc-missing",
  policyDeniedMcpServer: "policy/mcp-denied-server",
  policyUnapprovedMcpServer: "policy/mcp-unapproved-server",
  policyDeniedModelProvider: "policy/models-denied-provider",
  policyUnapprovedModelProvider: "policy/models-unapproved-provider",
  policyPrivateNetworkAccess: "policy/network-private-access-enabled",
  policyMissingToolRisk: "policy/tools-missing-risk-level",
  policyMissingToolSensitivity: "policy/tools-missing-sensitivity-token",
  policyUnknownToolSensitivity: "policy/tools-unknown-sensitivity-token",
} as const;

export const POLICY_CHECK_IDS = [
  CHECK_IDS.policyMissingFile,
  CHECK_IDS.policyHashMismatch,
  CHECK_IDS.policyDeniedChannelProvider,
  CHECK_IDS.policyDeniedMcpServer,
  CHECK_IDS.policyUnapprovedMcpServer,
  CHECK_IDS.policyDeniedModelProvider,
  CHECK_IDS.policyUnapprovedModelProvider,
  CHECK_IDS.policyPrivateNetworkAccess,
  CHECK_IDS.policyMissingToolRisk,
  CHECK_IDS.policyMissingToolSensitivity,
  CHECK_IDS.policyUnknownToolSensitivity,
] as const;

const KNOWN_SENSITIVITY_LEVELS = ["public", "internal", "confidential", "restricted"] as const;

let registered = false;
const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly findings: readonly HealthFinding[];
};

export function registerPolicyDoctorChecks(): void {
  if (registered) {
    return;
  }
  registerHealthCheck(policyMissingFileCheck);
  registerHealthCheck(policyHashMismatchCheck);
  registerHealthCheck(policyChannelsDeniedProviderCheck);
  registerHealthCheck(policyMcpDeniedServerCheck);
  registerHealthCheck(policyMcpUnapprovedServerCheck);
  registerHealthCheck(policyModelsDeniedProviderCheck);
  registerHealthCheck(policyModelsUnapprovedProviderCheck);
  registerHealthCheck(policyNetworkPrivateAccessCheck);
  registerHealthCheck(policyToolsMissingRiskCheck);
  registerHealthCheck(policyToolsMissingSensitivityCheck);
  registerHealthCheck(policyToolsUnknownSensitivityCheck);
  registered = true;
}

export function resetPolicyDoctorChecksForTest(): void {
  registered = false;
}

export function evaluatePolicy(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const cached = policyEvaluationCache.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const next = evaluatePolicyUncached(ctx);
  policyEvaluationCache.set(ctx, next);
  return next;
}

const policyMissingFileCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingFile,
  kind: "plugin",
  description: "The enabled policy extension has a policy file to verify.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
  },
};

const policyHashMismatchCheck: HealthCheck = {
  id: CHECK_IDS.policyHashMismatch,
  kind: "plugin",
  description: "The policy file matches the configured expected hash.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
  },
};

const policyChannelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedChannelProvider,
  kind: "plugin",
  description: "Configured channels satisfy policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
  },
  async repair(ctx, findings) {
    if (!(await workspaceRepairsEnabled(ctx))) {
      return workspaceRepairsDisabledResult("channel config");
    }
    const channelIds = channelIdsFromFindings(findings);
    if (channelIds.length === 0) {
      return {
        status: "skipped",
        reason: "no channel findings matched a configurable channel",
        changes: [],
      };
    }
    const next = disableChannels(ctx.cfg, channelIds);
    if (next.changed.length === 0) {
      return {
        status: "skipped",
        reason: "matching channels were already disabled or missing",
        changes: [],
      };
    }
    return {
      config: next.config,
      changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`),
    };
  },
};

const policyMcpDeniedServerCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedMcpServer,
  kind: "plugin",
  description: "Configured MCP servers do not match policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedMcpServer);
  },
};

const policyMcpUnapprovedServerCheck: HealthCheck = {
  id: CHECK_IDS.policyUnapprovedMcpServer,
  kind: "plugin",
  description: "Configured MCP servers do not match policy allow rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedMcpServer);
  },
};

const policyModelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedModelProvider,
  kind: "plugin",
  description: "Configured model providers do not match policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedModelProvider);
  },
};

const policyModelsUnapprovedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyUnapprovedModelProvider,
  kind: "plugin",
  description: "Configured model providers do not match policy allow rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedModelProvider);
  },
};

const policyNetworkPrivateAccessCheck: HealthCheck = {
  id: CHECK_IDS.policyPrivateNetworkAccess,
  kind: "plugin",
  description: "Network SSRF policy settings match private-network requirements.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyPrivateNetworkAccess);
  },
};

const policyToolsMissingRiskCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingToolRisk,
  kind: "plugin",
  description: "TOOLS.md policy entries declare explicit risk levels.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolRisk);
  },
};

const policyToolsMissingSensitivityCheck: HealthCheck = {
  id: CHECK_IDS.policyMissingToolSensitivity,
  kind: "plugin",
  description: "TOOLS.md policy entries declare default artifact sensitivity.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolSensitivity);
  },
};

const policyToolsUnknownSensitivityCheck: HealthCheck = {
  id: CHECK_IDS.policyUnknownToolSensitivity,
  kind: "plugin",
  description: "TOOLS.md policy entries use known sensitivity levels.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolSensitivity);
  },
};

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  const toolsFile = await readWorkspaceFile(ctx, "TOOLS.md");
  const evidence = collectPolicyEvidence(
    ctx.cfg as Record<string, unknown>,
    toolsFile === null ? {} : { toolsRaw: toolsFile.raw },
  );
  const findings: HealthFinding[] = [];

  if (settings.enabled === false) {
    return { policyPath, evidence, findings };
  }

  const policyFile = await readPolicyFile(ctx);
  if (policyFile === null) {
    findings.push({
      checkId: CHECK_IDS.policyMissingFile,
      severity: "warning",
      message: `${policyPath} is missing for the enabled policy extension.`,
      source: "policy",
      path: policyPath,
      fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`,
    });
    return { policyPath, evidence, findings };
  }

  const parsedPolicy = parsePolicyFile(policyFile.raw, policyFile.displayName);
  if (parsedPolicy.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { policyPath, evidence, findings };
  }

  const policy = parsedPolicy.ast.root === null ? {} : jsoncValueToUnknown(parsedPolicy.ast.root);
  const policyHash = policyDocumentHash(policy);
  const expectedHash = settings.expectedHash;
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    policyHash !== expectedHash.trim()
  ) {
    findings.push({
      checkId: CHECK_IDS.policyHashMismatch,
      severity: "error",
      message: `${policyFile.displayName} does not match the configured policy hash.`,
      source: "policy",
      path: policyFile.displayName,
      target: `oc://${policyFile.ocDocName}`,
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
      fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`,
    });
  }

  findings.push(...channelFindings(policy, policyFile.ocDocName, evidence));
  findings.push(...mcpServerFindings(policy, policyFile.ocDocName, evidence));
  findings.push(...modelProviderFindings(policy, policyFile.ocDocName, evidence));
  findings.push(...networkFindings(policy, policyFile.ocDocName, evidence));
  if (policyRequirementEnabled(settings, policy, "requireRisk")) {
    findings.push(...toolRiskFindings(policyFile.ocDocName, evidence));
  }
  if (policyRequirementEnabled(settings, policy, "requireSensitivity")) {
    findings.push(...toolSensitivityFindings(policyFile.ocDocName, evidence));
  }

  return {
    policyPath,
    policy: { value: policy, hash: policyHash },
    evidence,
    findings,
  };
}

function findingsForCheck(
  evaluation: PolicyEvaluation,
  checkId: (typeof POLICY_CHECK_IDS)[number],
): readonly HealthFinding[] {
  return evaluation.findings.filter((finding) => finding.checkId === checkId);
}

function channelFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denyRules = readChannelDenyRules(policy, policyDocName);
  if (denyRules.length === 0) {
    return [];
  }
  return evidence.channels.flatMap((channel): HealthFinding[] => {
    if (channel.enabled === false) {
      return [];
    }
    const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
    if (rule === undefined) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyDeniedChannelProvider,
        severity: "error",
        message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: channel.ocPath,
        target: channel.ocPath,
        requirement: rule.requirement,
        fixHint:
          rule.reason ??
          "Disable this channel, remove it from config, or update the policy deny rule.",
      },
    ];
  });
}

function mcpServerFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readStringList(policy, ["mcp", "servers", "deny"]));
  const allowed = readStringList(policy, ["mcp", "servers", "allow"]);
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const server of evidence.mcpServers) {
    if (denied.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyDeniedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is denied by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.ocPath,
        target: server.ocPath,
        requirement: `oc://${policyDocName}/mcp/servers/deny`,
        fixHint: "Remove this configured MCP server or update the policy after review.",
      });
      continue;
    }
    if (allowedSet.size > 0 && !allowedSet.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyUnapprovedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is not in the policy allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.ocPath,
        target: server.ocPath,
        requirement: `oc://${policyDocName}/mcp/servers/allow`,
        fixHint: "Use an approved MCP server or update the policy after review.",
      });
    }
  }

  return findings;
}

function modelProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readStringList(policy, ["models", "providers", "deny"]));
  const allowed = readStringList(policy, ["models", "providers", "allow"]);
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const provider of evidence.modelProviders) {
    findings.push(...modelProviderConformanceFindings(provider, denied, allowedSet, policyDocName));
  }
  for (const modelRef of evidence.modelRefs) {
    findings.push(...modelRefConformanceFindings(modelRef, denied, allowedSet, policyDocName));
  }

  return findings;
}

function modelProviderConformanceFindings(
  provider: PolicyEvidence["modelProviders"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is denied by policy.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.ocPath,
      target: provider.ocPath,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Remove this configured provider or update the policy after review.",
    });
  }
  if (!denied.has(provider.id) && allowed.size > 0 && !allowed.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is not in the policy allowlist.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.ocPath,
      target: provider.ocPath,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Use an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

function modelRefConformanceFindings(
  modelRef: PolicyEvidence["modelRefs"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses denied provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.ocPath,
      target: modelRef.ocPath,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  if (!denied.has(modelRef.provider) && allowed.size > 0 && !allowed.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses unapproved provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.ocPath,
      target: modelRef.ocPath,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

function networkFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowPrivateNetwork = readPolicyBoolean(policy, ["network", "privateNetwork", "allow"]);
  if (allowPrivateNetwork !== false) {
    return [];
  }
  return evidence.network
    .filter((setting) => setting.value)
    .map((setting): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyPrivateNetworkAccess,
        severity: "error",
        message: `Network setting '${setting.id}' allows private-network access.`,
        source: "policy",
        path: "openclaw config",
        ocPath: setting.ocPath,
        target: setting.ocPath,
        requirement: `oc://${policyDocName}/network/privateNetwork/allow`,
        fixHint: "Disable this private-network access setting or update policy after review.",
      };
    });
}

function toolRiskFindings(policyDocName: string, evidence: PolicyEvidence): readonly HealthFinding[] {
  return evidence.tools
    .filter((tool) => tool.risk === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no explicit risk classification.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.ocPath,
        target: tool.ocPath,
        requirement: `oc://${policyDocName}/tools/settings/requireRisk`,
        fixHint: "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
      };
    });
}

function toolSensitivityFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return evidence.tools.flatMap((tool): HealthFinding[] => {
    if (tool.sensitivity === undefined) {
      return [
        {
          checkId: CHECK_IDS.policyMissingToolSensitivity,
          severity: "error",
          message: `TOOLS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          source: "policy",
          path: "TOOLS.md",
          line: tool.line,
          ocPath: tool.ocPath,
          target: tool.ocPath,
          requirement: `oc://${policyDocName}/tools/settings/requireSensitivity`,
          fixHint: `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        },
      ];
    }
    if (
      KNOWN_SENSITIVITY_LEVELS.includes(
        tool.sensitivity as (typeof KNOWN_SENSITIVITY_LEVELS)[number],
      )
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyUnknownToolSensitivity,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.ocPath,
        target: tool.ocPath,
        requirement: `oc://${policyDocName}/tools/settings/requireSensitivity`,
        fixHint: `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
      },
    ];
  });
}

async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
  try {
    const fs = await import("node:fs/promises");
    return {
      raw: await fs.readFile(path, "utf-8"),
      path,
      displayName,
      ocDocName: basename(displayName),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await import("node:fs/promises");
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function resolveWorkspacePath(ctx: HealthCheckContext, fileName: string): string {
  if (isAbsolute(fileName)) {
    return fileName;
  }
  return resolve(ctx.cwd ?? process.cwd(), fileName);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
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

async function workspaceRepairsEnabled(ctx: HealthCheckContext): Promise<boolean> {
  return (await resolvePolicyBooleanSetting(ctx, "workspaceRepairs")) === true;
}

function workspaceRepairsDisabledResult(fileName: string): {
  readonly status: "skipped";
  readonly reason: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
} {
  const reason = "workspace repairs are disabled";
  return {
    status: "skipped",
    reason,
    changes: [],
    warnings: [
      `Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`,
    ],
  };
}

function readChannelDenyRules(policy: unknown, policyDocName: string): readonly {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
  readonly requirement: string;
}[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules
    .map((rule, index) => ({ rule, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly index: number;
        readonly rule: {
          readonly id?: string;
          readonly when?: { readonly provider?: string };
          readonly reason?: string;
        };
      } =>
        isRecord(entry.rule) &&
        (entry.rule.id === undefined || typeof entry.rule.id === "string") &&
        (entry.rule.reason === undefined || typeof entry.rule.reason === "string") &&
        isRecord(entry.rule.when) &&
        typeof entry.rule.when.provider === "string",
    )
    .map(({ rule, index }) => {
      const next: {
        id?: string;
        when?: { readonly provider?: string };
        reason?: string;
        requirement: string;
      } = {
        when: rule.when,
        requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
      };
      if (rule.id !== undefined) {
        next.id = rule.id;
      }
      if (rule.reason !== undefined) {
        next.reason = rule.reason;
      }
      return next;
    });
}

function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

function disableChannels(
  cfg: HealthCheckContext["cfg"],
  channelIds: readonly string[],
): { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] } {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changed: [] };
  }
  const channels: Record<string, unknown> = { ...cfg.channels };
  const changed: string[] = [];
  for (const id of channelIds) {
    const current = channels[id];
    if (!isRecord(current) || current.enabled === false) {
      continue;
    }
    channels[id] = { ...current, enabled: false };
    changed.push(id);
  }
  if (changed.length === 0) {
    return { config: cfg, changed };
  }
  return { config: { ...cfg, channels }, changed };
}

async function resolvePolicyBooleanSetting(
  ctx: HealthCheckContext,
  setting: "enabled" | "requireRisk" | "requireSensitivity" | "workspaceRepairs",
): Promise<boolean | undefined> {
  const configured = policySettings(ctx)[setting];
  if (typeof configured === "boolean") {
    return configured;
  }
  const file = await readPolicyFile(ctx);
  if (file === null) {
    return undefined;
  }
  const parsed = parsePolicyFile(file.raw, file.displayName);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return undefined;
  }
  return (
    readJsoncBoolean(parsed.ast, file.ocDocName, `tools.settings.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, `settings.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, `policy.${setting}`) ??
    readJsoncBoolean(parsed.ast, file.ocDocName, setting)
  );
}

function policySettings(ctx: HealthCheckContext): {
  readonly enabled?: boolean;
  readonly requireRisk?: boolean;
  readonly requireSensitivity?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly path?: string;
} {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

function policyRequirementEnabled(
  settings: ReturnType<typeof policySettings>,
  policy: unknown,
  setting: "requireRisk" | "requireSensitivity",
): boolean {
  const configured = settings[setting];
  if (typeof configured === "boolean") {
    return configured;
  }
  return (
    readPolicyBoolean(policy, ["tools", "settings", setting]) ??
    readPolicyBoolean(policy, ["settings", setting]) ??
    readPolicyBoolean(policy, ["policy", setting]) ??
    readPolicyBoolean(policy, [setting]) ??
    false
  );
}

function readStringList(policy: unknown, path: readonly string[]): readonly string[] {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return [];
    }
    current = current[part];
  }
  if (!Array.isArray(current)) {
    return [];
  }
  return current.filter((entry): entry is string => typeof entry === "string");
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
function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsoncBoolean(ast: JsoncAst, docName: string, path: string): boolean | undefined {
  const match = resolveOcPath(ast, parseOcPath(`oc://${docName}/${path}`));
  if (match?.kind !== "leaf" || match.leafType !== "boolean") {
    return undefined;
  }
  return match.valueText === "true";
}
