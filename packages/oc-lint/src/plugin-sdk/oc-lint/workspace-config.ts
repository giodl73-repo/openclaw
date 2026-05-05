/**
 * `workspace.json` lint section — the shape pinch reads from the
 * universal config loader. Each substrate ships its own section
 * type + resolver locally; oc-path has no upfront
 * declaration of which sections exist.
 *
 * Read pattern (in pinch CLI):
 *
 *   import { loadWorkspaceConfig } from '@openclaw/oc-path';
 *   import { resolveLintOverrides } from './workspace-config.js';
 *
 *   const cfg = await loadWorkspaceConfig(workspaceDir);
 *   const lintSection = (cfg?.['lint'] ?? undefined) as WorkspaceLintConfig | undefined;
 *   const overrides = resolveLintOverrides(lintSection, cliFlags, ruleIds);
 *
 * @module @openclaw/oc-lint/workspace-config
 */

import { matchRuleIdGlob } from '@openclaw/oc-path';
import type { LintSeverity } from './types.js';

export interface WorkspaceLintConfig {
  /**
   * Rule IDs (or glob patterns) to skip. Each entry is matched
   * against every registered rule's `id`; matches are excluded.
   *   skip: ["policy-starter-v0/tools/duplicate-tool-id"]
   *   skip: ["lkg-starter-v0/*"]   // disable a whole namespace
   */
  readonly skip?: readonly string[];
  /**
   * Per-rule severity overrides. Maps rule ID → effective severity.
   *   severity: { "lkg-starter-v0/lkg/sentinel-in-content": "error" }
   */
  readonly severity?: Readonly<Record<string, LintSeverity>>;
  /**
   * Allowlist by glob. When present, ONLY rules whose ID matches
   * one of these globs run.
   *   only: ["policy-starter-v0/*"]
   */
  readonly only?: readonly string[];
}

export interface ResolvedLintOverrides {
  readonly disabledRuleIds: ReadonlySet<string>;
  readonly severityOverrides: Readonly<Record<string, LintSeverity>>;
  readonly onlyGlobs: readonly string[];
}

/**
 * Merge workspace.json lint defaults with CLI flag overrides.
 * CLI flags WIN per-id; only-globs UNION.
 */
export function resolveLintOverrides(
  section: WorkspaceLintConfig | undefined,
  cliFlags: {
    readonly skip?: readonly string[];
    readonly severity?: Readonly<Record<string, LintSeverity>>;
    readonly only?: readonly string[];
  },
  registeredRuleIds: readonly string[],
): ResolvedLintOverrides {
  const wsSkipGlobs = section?.skip ?? [];
  const wsSeverity = section?.severity ?? {};
  const wsOnly = section?.only ?? [];

  // Glob-expand workspace skips against registered rule IDs.
  const disabled = new Set<string>();
  for (const glob of wsSkipGlobs) {
    for (const id of registeredRuleIds) {
      if (matchRuleIdGlob(glob, id)) disabled.add(id);
    }
  }
  // CLI --skip is exact-id (matches existing pinch flag shape).
  for (const id of cliFlags.skip ?? []) disabled.add(id);

  // Severity merge: workspace defaults, CLI overrides per id.
  const severity: Record<string, LintSeverity> = { ...wsSeverity };
  if (cliFlags.severity !== undefined) {
    for (const [id, sev] of Object.entries(cliFlags.severity)) {
      severity[id] = sev;
    }
  }

  // Only globs: UNION of workspace + CLI.
  const onlyGlobs: string[] = [...wsOnly, ...(cliFlags.only ?? [])];

  return {
    disabledRuleIds: disabled,
    severityOverrides: severity,
    onlyGlobs,
  };
}
