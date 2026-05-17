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

const sandboxRegistryFilesCheck: HealthCheck = {
  id: "core/doctor/sandbox/registry-files",
  kind: "core",
  description: "Legacy sandbox registry files are detected and repairable.",
  source: "doctor",
  async detect() {
    const { detectLegacySandboxRegistryFileHealth } = await import("../commands/doctor-sandbox.js");
    const findings = await detectLegacySandboxRegistryFileHealth();
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/sandbox/registry-files",
        severity: "warning",
        message: finding.message,
        source: "sandbox-registry",
        path: finding.registryPath,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair() {
    const { repairLegacySandboxRegistryFileHealth } = await import("../commands/doctor-sandbox.js");
    const result = await repairLegacySandboxRegistryFileHealth();
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const sandboxImagesCheck: HealthCheck = {
  id: "core/doctor/sandbox/images",
  kind: "core",
  description: "Sandbox image and Docker readiness checks are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectSandboxImageHealth } = await import("../commands/doctor-sandbox.js");
    const findings = await detectSandboxImageHealth({ cfg: ctx.cfg });
    return findings.map((finding): HealthFinding => {
      const healthFinding: {
        checkId: string;
        severity: "warning";
        message: string;
        source: string;
        fixHint: string;
        path?: string;
      } = {
        checkId: "core/doctor/sandbox/images",
        severity: "warning",
        message: finding.message,
        source: "sandbox",
        fixHint: finding.fixHint,
      };
      if (finding.image) {
        healthFinding.path = finding.image;
      }
      return healthFinding;
    });
  },
  async repair(ctx) {
    const { repairSandboxImageHealth } = await import("../commands/doctor-sandbox.js");
    const result = await repairSandboxImageHealth({
      cfg: ctx.cfg,
      runtime: ctx.runtime,
      confirm: ctx.doctor?.confirm,
    });
    return {
      status: result.status,
      reason: result.reason,
      config: result.config,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const sandboxScopeCheck: HealthCheck = {
  id: "core/doctor/sandbox-scope",
  kind: "core",
  description: "Sandbox shared-scope agent overrides are detected.",
  source: "doctor",
  async detect(ctx) {
    const { detectSandboxScopeHealth } = await import("../commands/doctor-sandbox.js");
    const findings = detectSandboxScopeHealth(ctx.cfg);
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/sandbox-scope",
        severity: "warning",
        message: finding.message,
        path: finding.path,
        source: "openclaw.jsonc",
        fixHint:
          "Use a non-shared sandbox scope for agents with sandbox docker/browser/prune overrides, or remove the ignored overrides.",
      }),
    );
  },
};

const authProfilesFlatStoreCheck: HealthCheck = {
  id: "core/doctor/auth-profiles/flat-store",
  kind: "core",
  description: "Legacy flat auth profile stores are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyFlatAuthProfileHealth } =
      await import("../commands/doctor-auth-flat-profiles.js");
    const findings = await detectLegacyFlatAuthProfileHealth({
      cfg: ctx.cfg,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/auth-profiles/flat-store",
        severity: "warning",
        message: finding.message,
        source: "auth-profiles",
        path: finding.authPath,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairLegacyFlatAuthProfileHealth } =
      await import("../commands/doctor-auth-flat-profiles.js");
    const result = await repairLegacyFlatAuthProfileHealth({
      cfg: ctx.cfg,
      confirm: ctx.doctor?.confirm,
    });
    return {
      config: result.config,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const authProfilesOAuthSidecarCheck: HealthCheck = {
  id: "core/doctor/auth-profiles/oauth-sidecar",
  kind: "core",
  description: "Legacy OAuth sidecar profile stores are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyOAuthSidecarHealth } =
      await import("../commands/doctor-auth-oauth-sidecar.js");
    const findings = await detectLegacyOAuthSidecarHealth({
      cfg: ctx.cfg,
      env: ctx.env,
      includeUnreferenced: ctx.mode !== "fix",
    });
    return findings.map((finding): HealthFinding => {
      const healthFinding: {
        checkId: string;
        severity: "info" | "warning";
        message: string;
        source: string;
        path: string;
        fixHint?: string;
      } = {
        checkId: "core/doctor/auth-profiles/oauth-sidecar",
        severity: finding.kind === "unreferenced-sidecar" ? "info" : "warning",
        message: finding.message,
        source: "auth-profiles",
        path: finding.path,
      };
      if (finding.fixHint) {
        healthFinding.fixHint = finding.fixHint;
      }
      return healthFinding;
    });
  },
  async repair(ctx) {
    const { repairLegacyOAuthSidecarHealth } =
      await import("../commands/doctor-auth-oauth-sidecar.js");
    const result = await repairLegacyOAuthSidecarHealth({
      cfg: ctx.cfg,
      confirm: ctx.doctor?.confirm,
      env: ctx.env,
    });
    return {
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const authProfilesOAuthIdsCheck: HealthCheck = {
  id: "core/doctor/auth-profiles/oauth-ids",
  kind: "core",
  description: "Legacy OAuth profile ids are detected and repairable.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyOAuthProfileIdHealth } =
      await import("../commands/doctor-auth-legacy-oauth.js");
    const findings = await detectLegacyOAuthProfileIdHealth({
      cfg: ctx.cfg,
      env: ctx.env,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/auth-profiles/oauth-ids",
        severity: "warning",
        message: finding.message,
        source: "openclaw.jsonc",
        ocPath: `auth.profiles.${finding.fromProfileId}`,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { repairLegacyOAuthProfileIdHealth } =
      await import("../commands/doctor-auth-legacy-oauth.js");
    const result = await repairLegacyOAuthProfileIdHealth({
      cfg: ctx.cfg,
      confirm: ctx.doctor?.confirm,
      env: ctx.env,
    });
    return {
      config: result.config,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const authProfilesCodexProviderCheck: HealthCheck = {
  id: "core/doctor/auth-profiles/codex-provider",
  kind: "core",
  description: "Legacy Codex provider overrides are detected when Codex OAuth is configured.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyCodexProviderOverrideHealth } = await import("../commands/doctor-auth.js");
    const findings = detectLegacyCodexProviderOverrideHealth(ctx.cfg);
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/auth-profiles/codex-provider",
        severity: "warning",
        message: finding.message,
        source: "openclaw.jsonc",
        ocPath: "models.providers.openai-codex",
        fixHint: finding.fixHint,
      }),
    );
  },
};

const authProfilesKeychainCheck: HealthCheck = {
  id: "core/doctor/auth-profiles/keychain",
  kind: "core",
  description: "Auth profile token and OAuth readiness is reported as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { detectAuthProfileKeychainHealth } = await import("../commands/doctor-auth.js");
    return (await detectAuthProfileKeychainHealth(ctx.cfg)).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/auth-profiles/keychain",
        severity: "warning",
        message: finding.message,
        source: "auth-profiles",
        path: finding.profileId ? `auth.profiles.${finding.profileId}` : undefined,
        fixHint: finding.fixHint,
      }),
    );
  },
};

const configuredPluginInstallsCheck: HealthCheck = {
  id: "core/doctor/configured-plugin-installs",
  kind: "core",
  description: "Configured plugin and channel installs are present for the current release.",
  source: "doctor",
  async detect(ctx, scope) {
    if (ctx.sourceConfigValid === false) {
      return [];
    }
    const { collectReleaseConfiguredPluginIds, shouldRunConfiguredPluginInstallReleaseStep } =
      await import("../commands/doctor/shared/release-configured-plugin-installs.js");
    const configured = collectReleaseConfiguredPluginIds({ cfg: ctx.cfg, env: ctx.env });
    const touchedVersion =
      ctx.mode === "fix" && scope?.findings && scope.findings.length > 0
        ? ctx.cfg.meta?.lastTouchedVersion
        : (ctx.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion);
    const shouldRunReleaseStep = shouldRunConfiguredPluginInstallReleaseStep({ touchedVersion });
    const shouldRunFixRepair =
      ctx.mode === "fix" && (scope?.findings === undefined || scope.findings.length === 0);
    if (!shouldRunReleaseStep && !shouldRunFixRepair) {
      return [];
    }
    if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) {
      return shouldRunReleaseStep
        ? [
            {
              checkId: "core/doctor/configured-plugin-installs",
              severity: "warning",
              message: "Configured plugin/channel install release marker needs to be updated.",
              path: "meta.lastTouchedVersion",
              fixHint: "Run `openclaw doctor --fix` to mark the release migration complete.",
            },
          ]
        : [];
    }
    const labels = [
      ...configured.pluginIds.map((id) => `plugin:${id}`),
      ...configured.channelIds.map((id) => `channel:${id}`),
    ];
    return [
      {
        checkId: "core/doctor/configured-plugin-installs",
        severity: "warning",
        message: `Configured plugin/channel install repair needs to run for ${labels.join(", ")}.`,
        path: "plugins.entries",
        fixHint: "Run `openclaw doctor --fix` to install missing configured plugins/channels.",
      },
    ];
  },
  async repair(ctx) {
    if (ctx.sourceConfigValid === false) {
      return { status: "skipped", reason: "source config is invalid", changes: [] };
    }
    const { VERSION } = await import("../version.js");
    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("../commands/doctor/shared/release-configured-plugin-installs.js");
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: ctx.cfg,
      env: ctx.env,
      touchedVersion: ctx.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion,
    });
    const madeChanges = result.changes.length > 0;
    return {
      config: result.touchedConfig
        ? {
            ...ctx.cfg,
            meta: {
              ...ctx.cfg.meta,
              lastTouchedVersion: VERSION,
              lastTouchedAt: new Date().toISOString(),
            },
          }
        : ctx.cfg,
      status: result.completed || madeChanges ? "repaired" : "skipped",
      reason:
        result.completed || madeChanges
          ? undefined
          : "configured plugin install repair did not complete",
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const pluginRegistryCheck: HealthCheck = {
  id: "core/doctor/plugin-registry",
  kind: "core",
  description: "Plugin registry state and managed npm peer links are current.",
  source: "doctor",
  async detect(ctx) {
    const { detectPluginRegistryHealth } = await import("../commands/doctor-plugin-registry.js");
    return (
      await detectPluginRegistryHealth({
        config: ctx.cfg,
        env: ctx.env ?? process.env,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/plugin-registry",
        severity: finding.severity,
        message: finding.message,
        source: "plugin-registry",
        path: finding.path,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { maybeRepairPluginRegistryState } =
      await import("../commands/doctor-plugin-registry.js");
    const config = await maybeRepairPluginRegistryState({
      config: ctx.cfg,
      env: ctx.env ?? process.env,
      prompter: { shouldRepair: true },
    });
    return {
      config,
      changes: [],
    };
  },
};

const stateIntegrityCheck: HealthCheck = {
  id: "core/doctor/state-integrity",
  kind: "core",
  description: "State directories, permissions, and session stores are internally consistent.",
  source: "doctor",
  async detect(ctx) {
    const { detectStateIntegrityHealthFindings } =
      await import("../commands/doctor-state-integrity.js");
    return (
      await detectStateIntegrityHealthFindings({
        cfg: ctx.cfg,
        configPath: ctx.configPath,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/state-integrity",
        severity: finding.severity,
        message: finding.message,
        source: "state",
        path: finding.path,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { noteStateIntegrity } = await import("../commands/doctor-state-integrity.js");
    await noteStateIntegrity(ctx.cfg, prompter, ctx.configPath);
    return { changes: [] };
  },
};

const gatewayServicesExtraCheck: HealthCheck = {
  id: "core/doctor/gateway-services/extra",
  kind: "core",
  description: "Only the intended Gateway service is active for the current host.",
  source: "doctor",
  async detect(ctx) {
    const { detectExtraGatewayServiceFindings } =
      await import("../commands/doctor-gateway-services.js");
    return (
      await detectExtraGatewayServiceFindings({
        deep: ctx.doctor?.options?.deep,
        env: ctx.env ?? process.env,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/gateway-services/extra",
        severity: "warning",
        message: finding.message,
        source: "gateway-service",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { maybeScanExtraGatewayServices } =
      await import("../commands/doctor-gateway-services.js");
    await maybeScanExtraGatewayServices(ctx.doctor?.options ?? {}, ctx.runtime, prompter);
    return { changes: [] };
  },
};

const gatewayServicesConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-services/config",
  kind: "core",
  description: "Local Gateway service config matches the current OpenClaw install.",
  source: "doctor",
  async detect(ctx) {
    const { detectGatewayServiceConfigFindings } =
      await import("../commands/doctor-gateway-services.js");
    return (
      await detectGatewayServiceConfigFindings({
        cfg: ctx.cfg,
        mode: resolveDoctorMode(ctx.cfg),
        env: ctx.env ?? process.env,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/gateway-services/config",
        severity: finding.severity,
        message: finding.message,
        source: "gateway-service",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { maybeRepairGatewayServiceConfig } =
      await import("../commands/doctor-gateway-services.js");
    await maybeRepairGatewayServiceConfig(
      ctx.cfg,
      resolveDoctorMode(ctx.cfg),
      ctx.runtime,
      prompter,
    );
    return { changes: [] };
  },
};

const whatsappResponsivenessCheck: HealthCheck = {
  id: "core/doctor/whatsapp-responsiveness",
  kind: "core",
  description: "WhatsApp responsiveness is not blocked by degraded Gateway/TUI state.",
  source: "doctor",
  async detect(ctx) {
    const { detectWhatsappResponsivenessHealth } =
      await import("../commands/doctor-whatsapp-responsiveness.js");
    return detectWhatsappResponsivenessHealth({
      cfg: ctx.cfg,
      status: ctx.facts?.gatewayStatus,
    }).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/whatsapp-responsiveness",
        severity: "warning",
        message: finding.message,
        source: "whatsapp",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair() {
    const { repairWhatsappResponsivenessHealth } =
      await import("../commands/doctor-whatsapp-responsiveness.js");
    const result = await repairWhatsappResponsivenessHealth({});
    return {
      status: result.failed.length === 0 ? "repaired" : "failed",
      reason:
        result.failed.length > 0 ? `failed to stop ${result.failed.length} process(es)` : undefined,
      changes: result.stopped.map((pid) => `Stopped local TUI client ${pid}.`),
    };
  },
};

const memorySearchCheck: HealthCheck = {
  id: "core/doctor/memory-search",
  kind: "core",
  description: "Memory search has a usable backend and embedding provider.",
  source: "doctor",
  async detect(ctx) {
    const { detectMemorySearchHealth } = await import("../commands/doctor-memory-search.js");
    return (
      await detectMemorySearchHealth({
        cfg: ctx.cfg,
        gatewayMemoryProbe: ctx.facts?.gatewayMemoryProbe ?? {
          checked: false,
          ready: false,
          skipped: true,
        },
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/memory-search",
        severity: finding.severity,
        message: finding.message,
        source: "memory",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { maybeRepairWorkspaceMemoryHealth } = await import("../commands/doctor-workspace.js");
    await maybeRepairWorkspaceMemoryHealth({ cfg: ctx.cfg, prompter });
    return { changes: [] };
  },
};

const memoryRecallCheck: HealthCheck = {
  id: "core/doctor/memory-recall",
  kind: "core",
  description: "Memory recall and dreaming artifacts are healthy.",
  source: "doctor",
  async detect(ctx) {
    const { detectMemoryRecallHealth } = await import("../commands/doctor-memory-search.js");
    return (await detectMemoryRecallHealth(ctx.cfg)).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/memory-recall",
        severity: finding.severity,
        message: finding.message,
        source: "memory",
        path: finding.path,
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { maybeRepairMemoryRecallHealth } = await import("../commands/doctor-memory-search.js");
    await maybeRepairMemoryRecallHealth({
      cfg: ctx.cfg,
      prompter,
    });
    return { changes: [] };
  },
};

const memoryGatewayProbeCheck: HealthCheck = {
  id: "core/doctor/memory-gateway-probe",
  kind: "core",
  description: "Gateway memory probe reports embeddings ready when checked.",
  source: "doctor",
  async detect(ctx) {
    const probe = ctx.facts?.gatewayMemoryProbe;
    if (!probe || probe.skipped || probe.ready) {
      return [];
    }
    if (!probe.checked) {
      return [
        {
          checkId: "core/doctor/memory-gateway-probe",
          severity: "warning",
          message: "Gateway memory probe was not checked.",
          source: "memory",
          fixHint:
            "Run `openclaw doctor --deep` or `openclaw memory status --deep` to verify memory readiness.",
        },
      ];
    }
    return [
      {
        checkId: "core/doctor/memory-gateway-probe",
        severity: "warning",
        message: probe.error
          ? `Gateway memory probe is not ready: ${probe.error}`
          : "Gateway memory probe is not ready.",
        source: "memory",
        fixHint: "Run `openclaw memory status --deep` for details.",
      },
    ];
  },
};

const devicePairingCheck: HealthCheck = {
  id: "core/doctor/device-pairing",
  kind: "core",
  description: "Device pairing records and pending requests are consistent.",
  source: "doctor",
  async detect(ctx) {
    const { detectDevicePairingHealth } = await import("../commands/doctor-device-pairing.js");
    return (
      await detectDevicePairingHealth({
        cfg: ctx.cfg,
        healthOk: ctx.facts?.healthOk ?? false,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/device-pairing",
        severity: finding.severity,
        message: finding.message,
        source: "device-pairing",
        fixHint: finding.fixHint,
      }),
    );
  },
};

const gatewayDaemonCheck: HealthCheck = {
  id: "core/doctor/gateway-daemon",
  kind: "core",
  description: "Gateway daemon lifecycle is installed and runnable for local mode.",
  source: "doctor",
  async detect(ctx, scope) {
    const { detectGatewayDaemonHealth } = await import("../commands/doctor-gateway-daemon-flow.js");
    let healthOk = ctx.facts?.healthOk;
    if (ctx.mode === "fix" && scope?.findings !== undefined && scope.findings.length > 0) {
      const { checkGatewayHealth } = await import("../commands/doctor-gateway-health.js");
      healthOk = (
        await checkGatewayHealth({
          runtime: ctx.runtime,
          cfg: ctx.cfg,
          timeoutMs: ctx.doctor?.options?.nonInteractive === true ? 3000 : 10000,
        })
      ).healthOk;
    }
    return (
      await detectGatewayDaemonHealth({
        cfg: ctx.cfg,
        healthOk,
        env: ctx.env ?? process.env,
      })
    ).map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/gateway-daemon",
        severity: finding.severity,
        message: finding.message,
        source: "gateway",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const prompter = ctx.doctor?.prompter;
    if (prompter === undefined) {
      return { status: "skipped", reason: "doctor prompter unavailable", changes: [] };
    }
    const { maybeRepairGatewayDaemon } = await import("../commands/doctor-gateway-daemon-flow.js");
    await maybeRepairGatewayDaemon({
      cfg: ctx.cfg,
      runtime: ctx.runtime,
      prompter,
      options: ctx.doctor?.options ?? {},
      gatewayDetailsMessage: ctx.facts?.gatewayDetailsMessage ?? "",
      healthOk: ctx.facts?.healthOk ?? false,
    });
    const { checkGatewayHealth, probeGatewayMemoryStatus } =
      await import("../commands/doctor-gateway-health.js");
    const { healthOk, status } = await checkGatewayHealth({
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      timeoutMs: ctx.doctor?.options?.nonInteractive === true ? 3000 : 10000,
    });
    return {
      facts: {
        ...ctx.facts,
        healthOk,
        gatewayStatus: status,
        gatewayMemoryProbe: healthOk
          ? await probeGatewayMemoryStatus({
              cfg: ctx.cfg,
              timeoutMs: ctx.doctor?.options?.nonInteractive === true ? 3000 : 10000,
            })
          : { checked: false, ready: false, skipped: false },
      },
      changes: [],
    };
  },
};

const convertedWorkflowChecks: readonly HealthCheck[] = [
  authProfilesFlatStoreCheck,
  authProfilesOAuthSidecarCheck,
  authProfilesOAuthIdsCheck,
  authProfilesCodexProviderCheck,
  authProfilesKeychainCheck,
  claudeCliCheck,
  gatewayAuthCheck,
  legacyStateCheck,
  legacyPluginManifestCheck,
  configuredPluginInstallsCheck,
  pluginRegistryCheck,
  stateIntegrityCheck,
  codexSessionRoutesCheck,
  sessionLocksCheck,
  sessionTranscriptsCheck,
  configAuditScrubCheck,
  legacyCronStoreCheck,
  legacyWhatsAppCrontabCheck,
  sandboxRegistryFilesCheck,
  sandboxImagesCheck,
  sandboxScopeCheck,
  gatewayServicesExtraCheck,
  gatewayServicesConfigCheck,
  gatewayPlatformNotesCheck,
  startupChannelMaintenanceCheck,
  securityCheck,
  browserCheck,
  openAIOAuthTlsCheck,
  hooksModelCheck,
  systemdLingerCheck,
  bootstrapSizeCheck,
  shellCompletionCheck,
  gatewayDaemonCheck,
  whatsappResponsivenessCheck,
  memorySearchCheck,
  memoryRecallCheck,
  memoryGatewayProbeCheck,
  devicePairingCheck,
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
