import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  isDockerDaemonUnavailable,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import {
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
  type LegacySandboxRegistryInspection,
  type LegacySandboxRegistryMigrationResult,
} from "../agents/sandbox/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(scriptRel: string): SandboxScriptInfo | null {
  const candidates = new Set<string>();
  candidates.add(process.cwd());
  const argv1 = process.argv[1];
  if (argv1) {
    const normalized = path.resolve(argv1);
    candidates.add(path.resolve(path.dirname(normalized), ".."));
    candidates.add(path.resolve(path.dirname(normalized)));
  }

  for (const root of candidates) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }

  return null;
}

async function runSandboxScript(scriptRel: string, runtime: RuntimeEnv): Promise<boolean> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
    return false;
  }

  runtime.log(`Running ${scriptRel}...`);
  const result = await runCommandWithTimeout(["bash", script.scriptPath], {
    timeoutMs: 20 * 60 * 1000,
    cwd: script.cwd,
  });
  if (result.code !== 0) {
    runtime.error(
      `Failed running ${scriptRel}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
    return false;
  }

  runtime.log(`Completed ${scriptRel}.`);
  return true;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await runExec("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await runExec("docker", ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error) {
    const stderr =
      (error as { stderr: string } | undefined)?.stderr ||
      (error as { message: string } | undefined)?.message ||
      "";
    if (stderr.includes("No such image")) {
      return false;
    }
    if (isDockerDaemonUnavailable(stderr)) {
      return false;
    }
    throw error;
  }
}

function resolveSandboxDockerImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_IMAGE;
}

function resolveSandboxBackend(cfg: OpenClawConfig): string {
  const backend = cfg.agents?.defaults?.sandbox?.backend?.trim();
  return backend || "docker";
}

function resolveSandboxBrowserImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}

type SandboxImageCheck = {
  kind: string;
  image: string;
  buildScript?: string;
};

export type SandboxImageHealthFinding = {
  kind: "docker-unavailable" | "missing-image" | "unsupported-browser-backend";
  message: string;
  fixHint: string;
  details?: string;
  sandboxKind?: string;
  image?: string;
  buildScript?: string;
};

export type LegacySandboxRegistryFileHealthFinding = {
  registryPath: string;
  message: string;
  fixHint: string;
};

export type SandboxScopeHealthFinding = {
  agentId: string;
  ignoredOverrides: readonly string[];
  message: string;
  path: string;
};

function collectSandboxImageChecks(cfg: OpenClawConfig): SandboxImageCheck[] {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const dockerImage = resolveSandboxDockerImage(cfg);
  const checks: SandboxImageCheck[] = [
    {
      kind: "base",
      image: dockerImage,
      buildScript:
        dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
          ? "scripts/sandbox-common-setup.sh"
          : dockerImage === DEFAULT_SANDBOX_IMAGE
            ? "scripts/sandbox-setup.sh"
            : undefined,
    },
  ];
  if (sandbox?.browser?.enabled) {
    checks.push({
      kind: "browser",
      image: resolveSandboxBrowserImage(cfg),
      buildScript: "scripts/sandbox-browser-setup.sh",
    });
  }
  return checks;
}

function formatDockerUnavailableFinding(mode: string): SandboxImageHealthFinding {
  const lines = [
    `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
    "Docker is required for sandbox mode to function.",
    "Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
    "",
    "Options:",
    "- Install Docker and restart the gateway",
    "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
  ];
  return {
    kind: "docker-unavailable",
    message: `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
    fixHint:
      "Install Docker and restart the gateway, or disable sandbox mode with `openclaw config set agents.defaults.sandbox.mode off`.",
    details: lines.join("\n"),
  };
}

function missingSandboxImageToFinding(check: SandboxImageCheck): SandboxImageHealthFinding {
  const buildHint = check.buildScript
    ? `Build it with ${check.buildScript}.`
    : "Build or pull it first.";
  return {
    kind: "missing-image",
    sandboxKind: check.kind,
    image: check.image,
    buildScript: check.buildScript,
    message: `Sandbox ${check.kind} image missing: ${check.image}.`,
    fixHint: buildHint,
    details: `Sandbox ${check.kind} image missing: ${check.image}. ${buildHint}`,
  };
}

export async function detectSandboxImageHealth(params: {
  cfg: OpenClawConfig;
}): Promise<readonly SandboxImageHealthFinding[]> {
  const sandbox = params.cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return [];
  }
  const backend = resolveSandboxBackend(params.cfg);
  if (backend !== "docker") {
    return sandbox.browser?.enabled
      ? [
          {
            kind: "unsupported-browser-backend",
            message: `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
            fixHint:
              "Switch agents.defaults.sandbox.backend to docker, or disable agents.defaults.sandbox.browser.enabled.",
          },
        ]
      : [];
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return [formatDockerUnavailableFinding(mode)];
  }

  const findings: SandboxImageHealthFinding[] = [];
  for (const check of collectSandboxImageChecks(params.cfg)) {
    if (!(await dockerImageExists(check.image))) {
      findings.push(missingSandboxImageToFinding(check));
    }
  }
  return findings;
}

export async function repairSandboxImageHealth(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
}): Promise<{
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
  status?: "repaired" | "skipped" | "failed";
  reason?: string;
}> {
  const findings = await detectSandboxImageHealth({ cfg: params.cfg });
  const buildable = findings.filter(
    (finding) => finding.kind === "missing-image" && finding.buildScript && finding.sandboxKind,
  );
  if (buildable.length === 0) {
    return findings.length === 0
      ? { config: params.cfg, changes: [], warnings: [] }
      : {
          config: params.cfg,
          changes: [],
          warnings: [],
          status: "skipped",
          reason: "no buildable missing sandbox images",
        };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  for (const finding of buildable) {
    if (!finding.buildScript || !finding.sandboxKind || !finding.image) {
      continue;
    }
    if (params.confirm) {
      const build = await params.confirm({
        message: `Build ${finding.sandboxKind} sandbox image now?`,
        initialValue: true,
      });
      if (!build) {
        continue;
      }
    }
    const built = await runSandboxScript(finding.buildScript, params.runtime);
    if (built) {
      changes.push(`Built ${finding.sandboxKind} sandbox image ${finding.image}.`);
    } else {
      warnings.push(`Failed to build ${finding.sandboxKind} sandbox image ${finding.image}.`);
    }
  }

  if (warnings.length > 0) {
    return { config: params.cfg, changes, warnings, status: "failed" };
  }
  if (changes.length === 0) {
    return {
      config: params.cfg,
      changes,
      warnings,
      status: "skipped",
      reason: "sandbox image build declined",
    };
  }
  return { config: params.cfg, changes, warnings };
}

export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const findings = await detectSandboxImageHealth({ cfg });
  if (findings.length === 0) {
    return cfg;
  }
  note(findings.map((finding) => finding.details ?? finding.message).join("\n"), "Sandbox");
  const result = await repairSandboxImageHealth({
    cfg,
    runtime,
    confirm: (params) => prompter.confirmRuntimeRepair(params),
  });
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
  return result.config;
}

function formatLegacyRegistryInspectionLine(file: LegacySandboxRegistryInspection): string {
  const status = file.valid ? `${file.entries} entr${file.entries === 1 ? "y" : "ies"}` : "invalid";
  return `- ${file.kind}: ${shortenHomePath(file.registryPath)} (${status})`;
}

function formatLegacyRegistryMigrationLine(result: LegacySandboxRegistryMigrationResult): string {
  const file = shortenHomePath(result.registryPath);
  if (result.status === "migrated") {
    return `- Migrated ${result.kind} registry from ${file} into ${result.entries} shard${result.entries === 1 ? "" : "s"}.`;
  }
  if (result.status === "removed-empty") {
    return `- Removed empty legacy ${result.kind} registry ${file}.`;
  }
  if (result.status === "quarantined-invalid") {
    const quarantine = result.quarantinePath ? ` to ${shortenHomePath(result.quarantinePath)}` : "";
    return `- Quarantined invalid legacy ${result.kind} registry ${file}${quarantine}.`;
  }
  return "";
}

function legacySandboxRegistryInspectionToFinding(
  file: LegacySandboxRegistryInspection,
): LegacySandboxRegistryFileHealthFinding | null {
  if (!file.exists) {
    return null;
  }
  return {
    registryPath: file.registryPath,
    message: [
      "Legacy sandbox registry file detected.",
      formatLegacyRegistryInspectionLine(file),
    ].join("\n"),
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to migrate it to sharded registry files.`,
  };
}

export async function detectLegacySandboxRegistryFileHealth(): Promise<
  readonly LegacySandboxRegistryFileHealthFinding[]
> {
  return (await inspectLegacySandboxRegistryFiles())
    .map(legacySandboxRegistryInspectionToFinding)
    .filter((finding): finding is LegacySandboxRegistryFileHealthFinding => finding !== null);
}

export async function repairLegacySandboxRegistryFileHealth(): Promise<{
  status?: "repaired" | "skipped" | "failed";
  changes: string[];
  warnings: string[];
}> {
  const changes = (await migrateLegacySandboxRegistryFiles())
    .filter((result) => result.status !== "missing")
    .map(formatLegacyRegistryMigrationLine)
    .filter((line) => line.length > 0);
  return {
    changes,
    warnings: [],
  };
}

export async function maybeRepairSandboxRegistryFiles(prompter: DoctorPrompter): Promise<void> {
  const findings = await detectLegacySandboxRegistryFileHealth();
  if (findings.length === 0) {
    return;
  }

  if (!prompter.shouldRepair) {
    note(
      [
        "Legacy sandbox registry files detected.",
        ...findings.map((finding) => finding.message.split("\n").slice(1).join("\n")),
        `Run ${formatCliCommand("openclaw doctor --fix")} to migrate them to sharded registry files.`,
      ].join("\n"),
      "Sandbox",
    );
    return;
  }

  const result = await repairLegacySandboxRegistryFileHealth();
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

export function detectSandboxScopeHealth(
  cfg: OpenClawConfig,
): readonly SandboxScopeHealthFinding[] {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const findings: SandboxScopeHealthFinding[] = [];

  for (const [index, agent] of agents.entries()) {
    const agentId = agent.id;
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) {
      continue;
    }

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
    });

    if (scope !== "shared") {
      continue;
    }

    const overrides: string[] = [];
    if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) {
      overrides.push("docker");
    }
    if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) {
      overrides.push("browser");
    }
    if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) {
      overrides.push("prune");
    }

    if (overrides.length === 0) {
      continue;
    }

    findings.push({
      agentId,
      ignoredOverrides: overrides,
      message: `agents.list (id "${agentId}") sandbox ${overrides.join("/")} overrides ignored; scope resolves to "shared".`,
      path: `agents.list[${index}].sandbox`,
    });
  }

  return findings;
}

export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const warnings = detectSandboxScopeHealth(cfg).map((finding) =>
    [
      `- agents.list (id "${finding.agentId}") sandbox ${finding.ignoredOverrides.join("/")} overrides ignored.`,
      `  scope resolves to "shared".`,
    ].join("\n"),
  );
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}
