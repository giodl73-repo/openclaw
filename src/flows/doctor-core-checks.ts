import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "../commands/doctor-skills.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { registerHealthCheck } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";

export const TRANSITIONAL_DOCTOR_HEALTH_PLACEHOLDER_IDS = [
  "core/doctor/auth-profiles/flat-store",
  "core/doctor/auth-profiles/oauth-sidecar",
  "core/doctor/auth-profiles/oauth-ids",
  "core/doctor/auth-profiles/keychain",
  "core/doctor/auth-profiles/codex-provider",
  "core/doctor/configured-plugin-installs",
  "core/doctor/plugin-registry",
  "core/doctor/state-integrity",
  "core/doctor/sandbox/registry-files",
  "core/doctor/sandbox/images",
  "core/doctor/sandbox-scope",
  "core/doctor/gateway-services/extra",
  "core/doctor/gateway-services/config",
  "core/doctor/whatsapp-responsiveness",
  "core/doctor/memory-search",
  "core/doctor/memory-recall",
  "core/doctor/memory-gateway-probe",
  "core/doctor/device-pairing",
  "core/doctor/gateway-daemon",
] as const;

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map(
    (issue): HealthFinding => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: "error",
      message: issue.message,
      path: issue.path || "<root>",
    }),
  );
}

const gatewayConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-config",
  kind: "core",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  source: "doctor",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: HealthCheck = {
  id: "core/doctor/command-owner",
  kind: "core",
  description: "An owner account is configured for owner-only commands.",
  source: "doctor",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/command-owner",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

function resolveDoctorMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

const gatewayAuthCheck: HealthCheck = {
  id: "core/doctor/gateway-auth",
  kind: "core",
  description: "Local Gateway auth mode has a usable token or another explicit auth mode.",
  source: "doctor",
  async detect(ctx) {
    if (resolveDoctorMode(ctx.cfg) !== "local") {
      return [];
    }
    const gatewayTokenRef = resolveSecretInputRef({
      value: ctx.cfg.gateway?.auth?.token,
      defaults: ctx.cfg.secrets?.defaults,
    }).ref;
    const auth = resolveGatewayAuth({
      authConfig: ctx.cfg.gateway?.auth,
      tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
    });
    const needsToken =
      auth.mode !== "password" &&
      auth.mode !== "none" &&
      auth.mode !== "trusted-proxy" &&
      (auth.mode !== "token" || !auth.token);
    if (!needsToken) {
      return [];
    }
    if (gatewayTokenRef) {
      return [
        {
          checkId: "core/doctor/gateway-auth",
          severity: "warning",
          message: "Gateway token is managed via SecretRef and is currently unavailable.",
          path: "gateway.auth.token",
          fixHint: "Resolve or rotate the external secret source, then rerun doctor.",
        },
      ];
    }
    return [
      {
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: "Gateway auth is off or missing a token.",
        path: "gateway.auth",
        fixHint: "Run `openclaw doctor --fix --generate-gateway-token` to generate a token.",
      },
    ];
  },
};

const hooksModelCheck: HealthCheck = {
  id: "core/doctor/hooks-model",
  kind: "core",
  description: "hooks.gmail.model resolves to an allowed catalog model.",
  source: "doctor",
  async detect(ctx) {
    if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
      return [];
    }
    const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
    const { loadModelCatalog } = await import("../agents/model-catalog.js");
    const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
      await import("../agents/model-selection.js");
    const hooksModelRef = resolveHooksGmailModel({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      return [
        {
          checkId: "core/doctor/hooks-model",
          severity: "warning",
          message: `hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved.`,
          path: "hooks.gmail.model",
        },
      ];
    }
    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const catalog = await loadModelCatalog({ config: ctx.cfg });
    const status = getModelRefStatus({
      cfg: ctx.cfg,
      catalog,
      ref: hooksModelRef,
      defaultProvider,
      defaultModel,
    });
    const findings: HealthFinding[] = [];
    if (!status.allowed) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in agents.defaults.models allowlist.`,
        path: "hooks.gmail.model",
        fixHint: "Add the model to agents.defaults.models or remove hooks.gmail.model.",
      });
    }
    if (!status.inCatalog) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in the model catalog.`,
        path: "hooks.gmail.model",
        fixHint: "Choose a model from the configured provider catalog.",
      });
    }
    return findings;
  },
};

const legacyStateCheck: HealthCheck = {
  id: "core/doctor/legacy-state",
  kind: "core",
  description: "Legacy sessions, agent state, and channel auth paths have been migrated.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyStateMigrations } = await import("../commands/doctor-state-migrations.js");
    const detected = await detectLegacyStateMigrations({ cfg: ctx.cfg });
    return detected.preview.map(
      (line): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        severity: "warning",
        message: line.replace(/^- /, ""),
        path: detected.stateDir,
        fixHint: "Run `openclaw doctor --fix` to migrate legacy state.",
      }),
    );
  },
};

const bootstrapSizeCheck: HealthCheck = {
  id: "core/doctor/bootstrap-size",
  kind: "core",
  description: "Workspace bootstrap files fit within configured injection limits.",
  source: "doctor",
  async detect(ctx) {
    const { buildBootstrapInjectionStats, analyzeBootstrapBudget } =
      await import("../agents/bootstrap-budget.js");
    const { resolveBootstrapContextForRun } = await import("../agents/bootstrap-files.js");
    const { resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars } =
      await import("../agents/pi-embedded-helpers.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: ctx.cfg,
    });
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars: resolveBootstrapMaxChars(ctx.cfg),
      bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(ctx.cfg),
    });
    const findings: HealthFinding[] = [];
    for (const file of analysis.truncatedFiles) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: `${file.name} exceeds bootstrap limits and will be truncated.`,
        path: file.path,
        fixHint: "Reduce the file size or tune agents.defaults.bootstrapMaxChars/TotalMaxChars.",
      });
    }
    for (const file of analysis.nearLimitFiles) {
      if (file.truncated) {
        continue;
      }
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "info",
        message: `${file.name} is near the configured bootstrap file limit.`,
        path: file.path,
        fixHint: "Reduce the file size or tune agents.defaults.bootstrapMaxChars.",
      });
    }
    if (analysis.totalNearLimit) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: analysis.hasTruncation ? "warning" : "info",
        message: "Total bootstrap context is near the configured total limit.",
        path: workspaceDir,
        fixHint: "Reduce bootstrap file sizes or tune agents.defaults.bootstrapTotalMaxChars.",
      });
    }
    return findings;
  },
};

function normalizeDoctorNoteLine(line: string): string {
  return line.replace(/^- /, "").trim();
}

function noteTextToFinding(params: {
  checkId: string;
  severity: HealthFinding["severity"];
  text: string;
}): HealthFinding {
  const lines = params.text.split("\n");
  const first = normalizeDoctorNoteLine(lines[0] ?? params.text);
  const rest = lines.slice(1).join("\n");
  return {
    checkId: params.checkId,
    severity: params.severity,
    message: first,
    ...(rest ? { fixHint: rest } : {}),
  };
}

function inferCapturedNoteSeverity(text: string): HealthFinding["severity"] {
  if (text.includes("CRITICAL")) {
    return "error";
  }
  if (
    text.includes("- Fix:") ||
    text.includes("unavailable") ||
    text.includes("not found") ||
    text.includes("missing") ||
    text.includes("not readable") ||
    text.includes("not writable") ||
    text.includes("readonly")
  ) {
    return "warning";
  }
  return "info";
}

function createNoteCollector(checkId: string): {
  readonly findings: readonly HealthFinding[];
  noteFn(message: unknown): void;
} {
  const findings: HealthFinding[] = [];
  return {
    findings,
    noteFn(message: unknown) {
      const text = message instanceof Error ? message.message : String(message ?? "");
      if (!text.trim()) {
        return;
      }
      const severity = inferCapturedNoteSeverity(text);
      if (severity === "info") {
        return;
      }
      findings.push(
        noteTextToFinding({
          checkId,
          severity,
          text,
        }),
      );
    },
  };
}

const claudeCliCheck: HealthCheck = {
  id: "core/doctor/claude-cli",
  kind: "core",
  description: "Claude CLI readiness is captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
    const collector = createNoteCollector("core/doctor/claude-cli");
    noteClaudeCliHealth(ctx.cfg, {
      noteFn: collector.noteFn,
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
    });
    return collector.findings;
  },
};

const securityCheck: HealthCheck = {
  id: "core/doctor/security",
  kind: "core",
  description: "Security posture checks produce structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { collectSecurityWarnings } = await import("../commands/doctor-security.js");
    const warnings = await collectSecurityWarnings(ctx.cfg);
    return warnings.map((warning) =>
      noteTextToFinding({
        checkId: "core/doctor/security",
        severity: warning.includes("CRITICAL") ? "error" : "warning",
        text: warning,
      }),
    );
  },
};

const openAIOAuthTlsCheck: HealthCheck = {
  id: "core/doctor/oauth-tls",
  kind: "core",
  description: "OpenAI OAuth TLS prerequisites are satisfied before browser auth.",
  source: "doctor",
  async detect(ctx) {
    const {
      formatOpenAIOAuthTlsPreflightFix,
      runOpenAIOAuthTlsPreflight,
      shouldRunOpenAIOAuthTlsPrerequisites,
    } = await import("../commands/oauth-tls-preflight.js");
    if (!shouldRunOpenAIOAuthTlsPrerequisites({ cfg: ctx.cfg, deep: ctx.mode === "doctor" })) {
      return [];
    }
    const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
    if (result.ok || result.kind !== "tls-cert") {
      return [];
    }
    const fix = formatOpenAIOAuthTlsPreflightFix(result);
    return [
      noteTextToFinding({
        checkId: "core/doctor/oauth-tls",
        severity: "warning",
        text: fix,
      }),
    ];
  },
};

const legacyWhatsAppCrontabCheck: HealthCheck = {
  id: "core/doctor/legacy-whatsapp-crontab",
  kind: "core",
  description: "Legacy WhatsApp crontab health entries are detected as structured findings.",
  source: "doctor",
  async detect() {
    const { collectLegacyWhatsAppCrontabHealthWarning } =
      await import("../commands/doctor-cron.js");
    const warning = await collectLegacyWhatsAppCrontabHealthWarning();
    if (!warning) {
      return [];
    }
    return [
      noteTextToFinding({
        checkId: "core/doctor/legacy-whatsapp-crontab",
        severity: "warning",
        text: warning,
      }),
    ];
  },
};

const gatewayPlatformNotesCheck: HealthCheck = {
  id: "core/doctor/gateway-services/platform-notes",
  kind: "core",
  description: "Gateway platform notes are captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { collectMacGatewayPlatformWarnings } =
      await import("../commands/doctor-platform-notes.js");
    const warnings = await collectMacGatewayPlatformWarnings(ctx.cfg);
    return warnings.map((warning) =>
      noteTextToFinding({
        checkId: "core/doctor/gateway-services/platform-notes",
        severity: "warning",
        text: warning,
      }),
    );
  },
};

const browserCheck: HealthCheck = {
  id: "core/doctor/browser",
  kind: "core",
  description: "Browser readiness is captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { noteChromeMcpBrowserReadiness } = await import("../commands/doctor-browser.js");
    const collector = createNoteCollector("core/doctor/browser");
    await noteChromeMcpBrowserReadiness(ctx.cfg, { noteFn: collector.noteFn });
    return collector.findings;
  },
};

const workspaceStatusCheck: HealthCheck = {
  id: "core/doctor/workspace-status",
  kind: "core",
  description: "Workspace directory exists and has no legacy duplicates.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyWorkspaceDirs } = await import("../commands/doctor-workspace.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const legacy = detectLegacyWorkspaceDirs({ workspaceDir });
    if (legacy.legacyDirs.length === 0) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/workspace-status",
        severity: "info",
        message: `Detected ${legacy.legacyDirs.length} legacy workspace director${
          legacy.legacyDirs.length === 1 ? "y" : "ies"
        } alongside the active workspace.`,
        path: workspaceDir,
        fixHint:
          "Inspect the legacy directories and migrate or remove them; see `openclaw doctor` for the detailed migration prompt.",
      },
    ];
  },
};

const skillsReadinessCheck: HealthCheck = {
  id: "core/doctor/skills-readiness",
  kind: "core",
  description: "Allowed skills are usable in the current runtime environment.",
  source: "doctor",
  async detect(ctx, scope) {
    const unavailable = filterUnavailableSkillsForScope(
      detectUnavailableSkills(ctx.cfg),
      scope?.paths,
    );
    return unavailable.map(unavailableSkillToFinding);
  },
  async repair(ctx, findings) {
    const unavailable = filterUnavailableSkillsForScope(
      detectUnavailableSkills(ctx.cfg),
      findings.map((finding) => finding.path),
    );
    if (unavailable.length === 0) {
      return { changes: [] };
    }
    return {
      config: disableUnavailableSkillsInConfig(ctx.cfg, unavailable),
      changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
    };
  },
};

function unavailableSkillToFinding(skill: SkillStatusEntry): HealthFinding {
  return {
    checkId: "core/doctor/skills-readiness",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function filterUnavailableSkillsForScope(
  unavailable: readonly SkillStatusEntry[],
  paths: readonly (string | undefined)[] | undefined,
): SkillStatusEntry[] {
  const scopedPaths = new Set(paths?.filter((path): path is string => path !== undefined) ?? []);
  if (scopedPaths.size === 0) {
    return [...unavailable];
  }
  return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

const finalConfigValidationCheck: HealthCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "doctor",
  async detect() {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snap = await readConfigFileSnapshot();
    if (!snap.exists || snap.valid) {
      return [];
    }
    return configValidationIssuesToHealthFindings(snap.issues);
  },
};

const workspaceSuggestionsCheck: HealthCheck = {
  id: "core/doctor/workspace-suggestions",
  kind: "core",
  description:
    "Workspace backup and memory-system suggestions are captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { collectWorkspaceBackupTip } = await import("../commands/doctor-state-integrity.js");
    const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
      await import("../commands/doctor-workspace.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const findings: HealthFinding[] = [];
    const backupTip = collectWorkspaceBackupTip(workspaceDir);
    if (backupTip) {
      findings.push(
        noteTextToFinding({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          text: backupTip,
        }),
      );
    }
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      findings.push(
        noteTextToFinding({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          text: MEMORY_SYSTEM_PROMPT,
        }),
      );
    }
    return findings;
  },
};

const shellCompletionCheck: HealthCheck = {
  id: "core/doctor/shell-completion",
  kind: "core",
  description: "Shell completion status is detected and repairable through cached completion.",
  source: "doctor",
  async detect(ctx) {
    const { detectShellCompletionHealth } = await import("../commands/doctor-completion.js");
    return detectShellCompletionHealth(ctx.doctor?.options);
  },
  async repair(ctx) {
    const { repairShellCompletionHealth } = await import("../commands/doctor-completion.js");
    const result = await repairShellCompletionHealth({
      options: ctx.doctor?.options,
      deps: {
        confirm: ctx.doctor?.confirm,
      },
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const startupChannelMaintenanceCheck: HealthCheck = {
  id: "core/doctor/startup-channel-maintenance",
  kind: "core",
  description: "Channel plugin startup maintenance runs through structured doctor repair.",
  source: "doctor",
  async detect(ctx, scope) {
    if (ctx.mode !== "fix" || scope?.findings !== undefined) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/startup-channel-maintenance",
        severity: "info",
        message: "Channel plugin startup maintenance should run during doctor repair.",
      },
    ];
  },
  async repair(ctx) {
    const { maybeRunDoctorStartupChannelMaintenance } =
      await import("./doctor-startup-channel-maintenance.js");
    await maybeRunDoctorStartupChannelMaintenance({
      cfg: ctx.cfg,
      runtime: ctx.runtime,
      shouldRepair: true,
    });
    return { changes: [] };
  },
};

const systemdLingerCheck: HealthCheck = {
  id: "core/doctor/systemd-linger",
  kind: "core",
  description: "systemd user linger status is detected and repairable for local Gateway.",
  source: "doctor",
  async detect(ctx) {
    if (
      ctx.doctor?.options?.nonInteractive === true ||
      process.platform !== "linux" ||
      resolveDoctorMode(ctx.cfg) !== "local"
    ) {
      return [];
    }
    const { resolveGatewayService } = await import("../daemon/service.js");
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: ctx.env ?? process.env });
    } catch {
      loaded = false;
    }
    if (!loaded) {
      return [];
    }
    const { SYSTEMD_GATEWAY_LINGER_REASON, detectSystemdUserLingerFindings } =
      await import("../commands/systemd-linger.js");
    const findings = await detectSystemdUserLingerFindings({
      env: ctx.env,
      reason: SYSTEMD_GATEWAY_LINGER_REASON,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/systemd-linger",
        severity: "warning",
        message: finding.message,
        source: "systemd",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { SYSTEMD_GATEWAY_LINGER_REASON, repairSystemdUserLingerFinding } =
      await import("../commands/systemd-linger.js");
    const result = await repairSystemdUserLingerFinding({
      runtime: ctx.runtime,
      env: ctx.env,
      confirm: ctx.doctor?.confirm,
      reason: SYSTEMD_GATEWAY_LINGER_REASON,
      requireConfirm: true,
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const configAuditScrubCheck: HealthCheck = {
  id: "core/doctor/config-audit-scrub",
  kind: "core",
  description: "Config audit log entries are scrubbed through the current argv redactor.",
  source: "doctor",
  async detect(ctx) {
    const { detectConfigAuditScrubFindings } =
      await import("../commands/doctor-config-audit-scrub.js");
    const findings = await detectConfigAuditScrubFindings({
      env: ctx.env,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/config-audit-scrub",
        severity: "warning",
        message: finding.message,
        source: "config-audit.jsonl",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairConfigAuditScrubFindings } =
      await import("../commands/doctor-config-audit-scrub.js");
    const result = await repairConfigAuditScrubFindings({
      env: ctx.env,
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const codexSessionRoutesCheck: HealthCheck = {
  id: "core/doctor/codex-session-routes",
  kind: "core",
  description: "Legacy Codex session model/provider pins are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { maybeRepairCodexSessionRoutes } =
      await import("../commands/doctor/shared/codex-route-warnings.js");
    const result = await maybeRepairCodexSessionRoutes({
      cfg: ctx.cfg,
      env: ctx.env,
      shouldRepair: false,
    });
    return result.warnings.map(
      (warning): HealthFinding => ({
        checkId: "core/doctor/codex-session-routes",
        severity: "warning",
        message: warning,
        source: "session-store",
        fixHint:
          "Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
      }),
    );
  },
  async repair(ctx) {
    const { maybeRepairCodexSessionRoutes } =
      await import("../commands/doctor/shared/codex-route-warnings.js");
    const result = await maybeRepairCodexSessionRoutes({
      cfg: ctx.cfg,
      env: ctx.env,
      shouldRepair: true,
    });
    return {
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const sessionLocksCheck: HealthCheck = {
  id: "core/doctor/session-locks",
  kind: "core",
  description: "Stale session lock files are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectSessionLockHealthFindings } = await import("../commands/doctor-session-locks.js");
    const findings = await detectSessionLockHealthFindings({
      env: ctx.env,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/session-locks",
        severity: "warning",
        message: finding.message,
        source: "session-locks",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairSessionLockHealthFindings } = await import("../commands/doctor-session-locks.js");
    const result = await repairSessionLockHealthFindings({
      env: ctx.env,
    });
    return {
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const sessionTranscriptsCheck: HealthCheck = {
  id: "core/doctor/session-transcripts",
  kind: "core",
  description: "Broken prompt-rewrite transcript branches are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectSessionTranscriptHealthFindings } =
      await import("../commands/doctor-session-transcripts.js");
    const findings = await detectSessionTranscriptHealthFindings({
      env: ctx.env,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/session-transcripts",
        severity: "warning",
        message: finding.message,
        source: "session-transcripts",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairSessionTranscriptHealthFindings } =
      await import("../commands/doctor-session-transcripts.js");
    const result = await repairSessionTranscriptHealthFindings({
      env: ctx.env,
    });
    return {
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const legacyCronStoreCheck: HealthCheck = {
  id: "core/doctor/legacy-cron-store",
  kind: "core",
  description: "Legacy cron store entries are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyCronStoreHealth } = await import("../commands/doctor-cron.js");
    const findings = await detectLegacyCronStoreHealth({
      cfg: ctx.cfg,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/legacy-cron-store",
        severity: "warning",
        message: finding.message,
        source: "cron-store",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairLegacyCronStoreHealth } = await import("../commands/doctor-cron.js");
    const result = await repairLegacyCronStoreHealth({
      cfg: ctx.cfg,
      confirm: ctx.doctor?.confirm,
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const legacyPluginManifestCheck: HealthCheck = {
  id: "core/doctor/legacy-plugin-manifests",
  kind: "core",
  description: "Legacy plugin manifest contract keys are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyPluginManifestContractHealth } =
      await import("../commands/doctor-plugin-manifests.js");
    const findings = await detectLegacyPluginManifestContractHealth({
      config: ctx.cfg,
      env: ctx.env,
      workspaceDir: ctx.cwd,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/legacy-plugin-manifests",
        severity: "warning",
        message: finding.message,
        source: "plugin-manifest",
        path: finding.manifestPath,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairLegacyPluginManifestContractHealth } =
      await import("../commands/doctor-plugin-manifests.js");
    const result = await repairLegacyPluginManifestContractHealth({
      config: ctx.cfg,
      env: ctx.env,
      workspaceDir: ctx.cwd,
      runtime: ctx.runtime,
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

function createConvertedWorkflowCheck(id: string, description: string): HealthCheck {
  return {
    id,
    kind: "core",
    description,
    source: "doctor",
    async detect() {
      return [];
    },
  };
}

const convertedWorkflowChecks: readonly HealthCheck[] = [
  createConvertedWorkflowCheck(
    "core/doctor/auth-profiles/flat-store",
    "Legacy flat auth profile stores are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/auth-profiles/oauth-sidecar",
    "Legacy OAuth sidecar profiles are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/auth-profiles/oauth-ids",
    "Legacy OAuth profile ids are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/auth-profiles/keychain",
    "Auth profile keychain readiness is represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/auth-profiles/codex-provider",
    "Legacy Codex provider overrides are represented in the health registry.",
  ),
  claudeCliCheck,
  gatewayAuthCheck,
  legacyStateCheck,
  legacyPluginManifestCheck,
  createConvertedWorkflowCheck(
    "core/doctor/configured-plugin-installs",
    "Configured plugin install release repairs are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/plugin-registry",
    "Plugin registry checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/state-integrity",
    "State integrity checks are represented in the health registry.",
  ),
  codexSessionRoutesCheck,
  sessionLocksCheck,
  sessionTranscriptsCheck,
  configAuditScrubCheck,
  legacyCronStoreCheck,
  legacyWhatsAppCrontabCheck,
  createConvertedWorkflowCheck(
    "core/doctor/sandbox/registry-files",
    "Sandbox registry file checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/sandbox/images",
    "Sandbox image checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/sandbox-scope",
    "Sandbox scope checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/gateway-services/extra",
    "Extra Gateway service checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/gateway-services/config",
    "Gateway service config checks are represented in the health registry.",
  ),
  gatewayPlatformNotesCheck,
  startupChannelMaintenanceCheck,
  securityCheck,
  browserCheck,
  openAIOAuthTlsCheck,
  hooksModelCheck,
  systemdLingerCheck,
  bootstrapSizeCheck,
  shellCompletionCheck,
  createConvertedWorkflowCheck(
    "core/doctor/whatsapp-responsiveness",
    "WhatsApp responsiveness checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/memory-search",
    "Memory search checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/memory-recall",
    "Memory recall checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/memory-gateway-probe",
    "Memory Gateway probe checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/device-pairing",
    "Device pairing checks are represented in the health registry.",
  ),
  createConvertedWorkflowCheck(
    "core/doctor/gateway-daemon",
    "Gateway daemon checks are represented in the health registry.",
  ),
  workspaceSuggestionsCheck,
];

let registered = false;

export function registerCoreHealthChecks(): void {
  if (registered) {
    return;
  }
  registerHealthCheck(gatewayConfigCheck);
  for (const check of convertedWorkflowChecks) {
    registerHealthCheck(check);
  }
  registerHealthCheck(commandOwnerCheck);
  registerHealthCheck(workspaceStatusCheck);
  registerHealthCheck(skillsReadinessCheck);
  registerHealthCheck(finalConfigValidationCheck);
  registered = true;
}

export function resetCoreHealthChecksForTest(): void {
  registered = false;
}

export const CORE_HEALTH_CHECKS: readonly HealthCheck[] = [
  gatewayConfigCheck,
  ...convertedWorkflowChecks,
  commandOwnerCheck,
  workspaceStatusCheck,
  skillsReadinessCheck,
  finalConfigValidationCheck,
];

function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

function formatMissingSkillSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}
