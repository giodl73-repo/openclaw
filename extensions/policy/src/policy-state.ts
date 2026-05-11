import { createHash } from "node:crypto";
import { parseOcDocument, type MdAst } from "@openclaw/oc-path/api.js";

export type PolicyAttestation = {
  readonly checkedAt: string;
  readonly policy?: {
    readonly path: string;
    readonly hash: string;
  };
  readonly workspace: {
    readonly scope: "policy";
    readonly hash: string;
  };
  readonly findingsHash?: string;
  readonly attestationHash?: string;
};

export type PolicyEvidence = {
  readonly channels: readonly PolicyChannelEvidence[];
  readonly mcpServers: readonly PolicyMcpServerEvidence[];
  readonly modelProviders: readonly PolicyModelProviderEvidence[];
  readonly modelRefs: readonly PolicyModelRefEvidence[];
  readonly network: readonly PolicyNetworkEvidence[];
  readonly tools: readonly PolicyToolEvidence[];
};

export type PolicyChannelEvidence = {
  readonly id: string;
  readonly provider: string;
  readonly ocPath: string;
  readonly enabled?: boolean;
};

export type PolicyMcpServerEvidence = {
  readonly id: string;
  readonly transport: "stdio" | "sse" | "streamable-http" | "unknown";
  readonly ocPath: string;
  readonly command?: string;
  readonly url?: string;
};

export type PolicyToolEvidence = {
  readonly id: string;
  readonly ocPath: string;
  readonly line: number;
  readonly risk?: string;
  readonly sensitivity?: string;
  readonly capabilities?: readonly string[];
};

export type PolicyModelProviderEvidence = {
  readonly id: string;
  readonly ocPath: string;
};

export type PolicyModelRefEvidence = {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly ocPath: string;
};

export type PolicyNetworkEvidence = {
  readonly id: string;
  readonly ocPath: string;
  readonly value: boolean;
};

export function policyDocumentHash(policy: unknown): string {
  return sha256(stableJson(policy));
}

export function policyWorkspaceHash(evidence: PolicyEvidence): string {
  return sha256(stableJson(evidence));
}

export function policyFindingsHash(findings: readonly unknown[]): string {
  return sha256(stableJson(findings));
}

export function policyAttestationHash(input: {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly policyHash?: string;
  readonly workspaceHash: string;
  readonly findingsHash: string;
}): string {
  return sha256(stableJson(input));
}

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: { readonly toolsRaw?: string } = {},
): PolicyEvidence {
  return {
    channels: scanPolicyChannels(cfg),
    mcpServers: scanPolicyMcpServers(cfg),
    modelProviders: scanPolicyModelProviders(cfg),
    modelRefs: scanPolicyModelRefs(cfg),
    network: scanPolicyNetwork(cfg),
    tools: options.toolsRaw === undefined ? [] : scanPolicyTools(options.toolsRaw),
  };
}

export function scanPolicyChannels(cfg: Record<string, unknown>): readonly PolicyChannelEvidence[] {
  return Object.entries(configuredChannels(cfg))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        provider: string;
        ocPath: string;
        enabled?: boolean;
      } = {
        id,
        provider: id,
        ocPath: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
}

export function scanPolicyMcpServers(cfg: Record<string, unknown>): readonly PolicyMcpServerEvidence[] {
  return Object.entries(configuredMcpServers(cfg))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        transport: "stdio" | "sse" | "streamable-http" | "unknown";
        ocPath: string;
        command?: string;
        url?: string;
      } = {
        id,
        transport: mcpServerTransport(value),
        ocPath: `oc://openclaw.config/mcp/servers/${id}`,
      };
      if (isRecord(value)) {
        if (typeof value.command === "string") {
          entry.command = value.command;
        }
        if (typeof value.url === "string") {
          entry.url = value.url;
        }
      }
      return entry;
    });
}

export function scanPolicyModelProviders(
  cfg: Record<string, unknown>,
): readonly PolicyModelProviderEvidence[] {
  return Object.keys(configuredModelProviders(cfg))
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      ocPath: `oc://openclaw.config/models/providers/${id}`,
    }));
}

export function scanPolicyModelRefs(cfg: Record<string, unknown>): readonly PolicyModelRefEvidence[] {
  const refs: PolicyModelRefEvidence[] = [];
  if (isRecord(cfg.agents)) {
    collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
  }
  return refs.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

export function scanPolicyNetwork(cfg: Record<string, unknown>): readonly PolicyNetworkEvidence[] {
  return [
    networkBooleanEvidence(
      cfg,
      "browser-private-network",
      ["browser", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "browser-private-network-legacy",
      ["browser", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network",
      ["tools", "web", "fetch", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network-legacy",
      ["tools", "web", "fetch", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-rfc2544-benchmark-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowRfc2544BenchmarkRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowRfc2544BenchmarkRange",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-ipv6-unique-local-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowIpv6UniqueLocalRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
    ),
  ].filter((entry): entry is PolicyNetworkEvidence => entry !== undefined);
}

export function scanPolicyTools(raw: string): readonly PolicyToolEvidence[] {
  const parsed = parseOcDocument(raw, { fileName: "TOOLS.md" });
  if (parsed.ast.kind !== "md") {
    return [];
  }
  return scanPolicyToolHeaders(parsed.ast);
}

function scanPolicyToolHeaders(ast: MdAst): readonly PolicyToolEvidence[] {
  const tools = ast.blocks.find((entry) => entry.slug === "tools");
  if (tools === undefined) {
    return [];
  }
  return tools.bodyText.split(/\r?\n/).flatMap((line, index): readonly PolicyToolEvidence[] => {
    const match = /^###\s+([^\s#]+)(.*)$/.exec(line);
    if (match === null) {
      return [];
    }
    const id = match[1].trim();
    const meta = match[2] ?? "";
    const entry: {
      id: string;
      ocPath: string;
      line: number;
      risk?: string;
      sensitivity?: string;
      capabilities?: readonly string[];
    } = {
      id,
      ocPath: `oc://TOOLS.md/tools/${id}`,
      line: tools.line + index + 1,
    };
    const risk = riskFromMeta(meta);
    const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
    const capabilities = meta.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (risk !== undefined) {
      entry.risk = risk;
    }
    if (sensitivity !== undefined) {
      entry.sensitivity = sensitivity;
    }
    if (capabilities.length > 0) {
      entry.capabilities = capabilities;
    }
    return [entry];
  });
}

function riskFromMeta(meta: string): string | undefined {
  const namedRisk = /\brisk\s*:\s*(low|medium|high|critical)\b/i.exec(meta)?.[1];
  if (namedRisk !== undefined) {
    return namedRisk.toLowerCase();
  }
  const alias = /\bR([0-5])\b/.exec(meta)?.[1];
  switch (alias) {
    case "0":
    case "1":
      return "low";
    case "2":
    case "3":
      return "medium";
    case "4":
      return "high";
    case "5":
      return "critical";
    default:
      return undefined;
  }
}

function configuredChannels(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.channels) ? cfg.channels : {};
}

function configuredMcpServers(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.mcp) && isRecord(cfg.mcp.servers) ? cfg.mcp.servers : {};
}

function mcpServerTransport(value: unknown): PolicyMcpServerEvidence["transport"] {
  if (!isRecord(value)) {
    return "unknown";
  }
  if (typeof value.command === "string") {
    return "stdio";
  }
  if (value.transport === "sse" || value.transport === "streamable-http") {
    return value.transport;
  }
  if (typeof value.url === "string") {
    return "streamable-http";
  }
  return "unknown";
}

function configuredModelProviders(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.models) && isRecord(cfg.models.providers) ? cfg.models.providers : {};
}

function networkBooleanEvidence(
  cfg: Record<string, unknown>,
  id: string,
  path: readonly string[],
  ocPath: string,
): PolicyNetworkEvidence | undefined {
  const value = readBooleanPath(cfg, path);
  return value === undefined ? undefined : { id, ocPath, value };
}

function readBooleanPath(value: unknown, path: readonly string[]): boolean | undefined {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

function collectModelRefsFromValue(
  refs: PolicyModelRefEvidence[],
  value: unknown,
  ocPath: string,
): void {
  if (typeof value === "string") {
    pushModelRef(refs, value, ocPath);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    pushModelRef(refs, value.primary, `${ocPath}/primary`);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        pushModelRef(refs, fallback, `${ocPath}/fallbacks/#${index}`);
      }
    }
  }
}

function collectModelRefsFromRecord(
  refs: PolicyModelRefEvidence[],
  value: Record<string, unknown>,
  ocPath: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${ocPath}/${key}`;
    if (isModelSettingKey(key)) {
      collectModelRefsFromValue(refs, child, childPath);
      continue;
    }
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      collectModelRefsFromRecord(refs, child, childPath);
    }
  }
}

function isModelSettingKey(key: string): boolean {
  return key === "model" || key.endsWith("Model");
}

function pushModelRef(refs: PolicyModelRefEvidence[], ref: string, ocPath: string): void {
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    return;
  }
  refs.push({ ref, provider: parsed.provider, model: parsed.model, ocPath });
}

function parseModelRef(ref: string): { readonly provider: string; readonly model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
