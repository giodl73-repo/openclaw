import { repairOAuthProfileIdMismatch } from "../agents/auth-profiles/repair.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileIdRepairResult, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

async function loadProviderRuntime() {
  return import("../plugins/providers.runtime.js");
}

async function loadNoteRuntime() {
  return import("../terminal/note.js");
}

function hasConfigOAuthProfiles(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.auth?.profiles ?? {}).some((profile) => profile?.mode === "oauth");
}

function sanitizePromptLabel(label: string | undefined): string | undefined {
  const sanitized = label ? sanitizeForLog(label).trim() : undefined;
  return sanitized || undefined;
}

export type LegacyOAuthProfileIdHealthFinding = {
  providerId: string;
  label: string;
  fromProfileId: string;
  toProfileId: string;
  message: string;
  fixHint: string;
};

type LegacyOAuthProfileIdRepairCandidate = LegacyOAuthProfileIdHealthFinding & {
  repair: AuthProfileIdRepairResult;
};

async function resolveProviderOAuthProfileIdRepairCandidates(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  providers: ProviderPlugin[];
  store: AuthProfileStore | null;
}> {
  if (!hasConfigOAuthProfiles(params.cfg)) {
    return { providers: [], store: null };
  }
  const store = ensureAuthProfileStore();
  if (Object.keys(store.profiles).length === 0) {
    return { providers: [], store: null };
  }
  const { resolvePluginProviders } = await loadProviderRuntime();
  return {
    store,
    providers: resolvePluginProviders({
      config: params.cfg,
      env: params.env,
      mode: "setup",
    }),
  };
}

function legacyOAuthProfileIdRepairToCandidate(params: {
  provider: ProviderPlugin;
  promptLabel?: string;
  repair: AuthProfileIdRepairResult;
}): LegacyOAuthProfileIdRepairCandidate | null {
  if (
    !params.repair.migrated ||
    params.repair.changes.length === 0 ||
    !params.repair.fromProfileId ||
    !params.repair.toProfileId
  ) {
    return null;
  }
  const label =
    sanitizePromptLabel(params.promptLabel) ??
    sanitizePromptLabel(params.provider.label) ??
    params.provider.id;
  return {
    providerId: params.provider.id,
    label,
    fromProfileId: params.repair.fromProfileId,
    toProfileId: params.repair.toProfileId,
    message: `${label} config uses legacy OAuth profile id ${params.repair.fromProfileId}; migrate it to ${params.repair.toProfileId}.`,
    fixHint: "Run `openclaw doctor --fix` to update openclaw.json auth profile ids.",
    repair: params.repair,
  };
}

function collectLegacyOAuthProfileIdRepairCandidates(params: {
  cfg: OpenClawConfig;
  providers: readonly ProviderPlugin[];
  store: AuthProfileStore;
  advanceConfig: boolean;
}): LegacyOAuthProfileIdRepairCandidate[] {
  const candidates: LegacyOAuthProfileIdRepairCandidate[] = [];
  let nextCfg = params.cfg;
  for (const provider of params.providers) {
    for (const repairSpec of provider.oauthProfileIdRepairs ?? []) {
      const repair = repairOAuthProfileIdMismatch({
        cfg: nextCfg,
        store: params.store,
        provider: provider.id,
        legacyProfileId: repairSpec.legacyProfileId,
      });
      const candidate = legacyOAuthProfileIdRepairToCandidate({
        provider,
        promptLabel: repairSpec.promptLabel,
        repair,
      });
      if (!candidate) {
        continue;
      }
      candidates.push(candidate);
      if (params.advanceConfig) {
        nextCfg = repair.config;
      }
    }
  }
  return candidates;
}

export async function detectLegacyOAuthProfileIdHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly LegacyOAuthProfileIdHealthFinding[]> {
  const { providers, store } = await resolveProviderOAuthProfileIdRepairCandidates({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
  if (!store) {
    return [];
  }
  return collectLegacyOAuthProfileIdRepairCandidates({
    cfg: params.cfg,
    providers,
    store,
    advanceConfig: true,
  }).map((candidate) => ({
    providerId: candidate.providerId,
    label: candidate.label,
    fromProfileId: candidate.fromProfileId,
    toProfileId: candidate.toProfileId,
    message: candidate.message,
    fixHint: candidate.fixHint,
  }));
}

export async function repairLegacyOAuthProfileIdHealth(params: {
  cfg: OpenClawConfig;
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  onCandidate?: (candidate: LegacyOAuthProfileIdRepairCandidate) => Promise<void> | void;
}): Promise<{ config: OpenClawConfig; changes: string[]; warnings: string[] }> {
  const { providers, store } = await resolveProviderOAuthProfileIdRepairCandidates({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
  if (!store) {
    return { config: params.cfg, changes: [], warnings: [] };
  }
  let nextCfg = params.cfg;
  const changes: string[] = [];
  for (const provider of providers) {
    for (const repairSpec of provider.oauthProfileIdRepairs ?? []) {
      const repair = repairOAuthProfileIdMismatch({
        cfg: nextCfg,
        store,
        provider: provider.id,
        legacyProfileId: repairSpec.legacyProfileId,
      });
      const candidate = legacyOAuthProfileIdRepairToCandidate({
        provider,
        promptLabel: repairSpec.promptLabel,
        repair,
      });
      if (!candidate) {
        continue;
      }
      await params.onCandidate?.(candidate);
      if (params.confirm) {
        const apply = await params.confirm({
          message: `Update ${candidate.label} OAuth profile id in config now?`,
          initialValue: true,
        });
        if (!apply) {
          continue;
        }
      }
      nextCfg = repair.config;
      changes.push(...repair.changes);
    }
  }
  return { config: nextCfg, changes, warnings: [] };
}

export async function maybeRepairLegacyOAuthProfileIds(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  if (!hasConfigOAuthProfiles(cfg)) {
    return cfg;
  }
  const result = await repairLegacyOAuthProfileIdHealth({
    cfg,
    confirm: prompter.confirm,
    onCandidate: async (candidate) => {
      const { note } = await loadNoteRuntime();
      note(candidate.repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
    },
  });
  return result.config;
}
