/**
 * `workspace.json` lkg section — the shape lkg
 * reads from the universal config loader. Locally owned by this
 * package; oc-path has no upfront declaration of which
 * sections exist.
 *
 * Read pattern (in openclaw-cage CLI):
 *
 *   import { loadWorkspaceConfig } from '@openclaw/oc-path';
 *   import { resolveLkgOverrides } from './workspace-config.js';
 *
 *   const cfg = await loadWorkspaceConfig(workspaceDir);
 *   const lkgSection = cfg?.['lkg'] as WorkspaceLkgConfig | undefined;
 *   const overrides = resolveLkgOverrides(lkgSection, cliFlags);
 *
 * @module @openclaw/lkg/workspace-config
 */

import { matchRuleIdGlob } from '@openclaw/oc-path';

export interface WorkspaceLkgConfig {
  /**
   * Role IDs to skip during observation sweeps (e.g.,
   * `'session.jsonl'`, `'config.jsonc'`). Matches the canonical
   * role's `id` field exactly.
   */
  readonly skip?: readonly string[];
  /**
   * Path globs (matched against `relPath`) to skip during
   * observation sweeps. Supports `*` and `{a,b,c}` alternation.
   *   skipPaths: ["sessions/*", "drafts/**"]
   */
  readonly skipPaths?: readonly string[];
}

export interface ResolvedLkgOverrides {
  readonly skipRoleIds: ReadonlySet<string>;
  readonly skipPathGlobs: readonly string[];
  shouldSkip(entry: { readonly roleId: string; readonly relPath: string }): boolean;
}

/**
 * Resolve effective LKG skip rules from (a) workspace.json `lkg`
 * section, (b) CLI `--skip` flag values. CLI values containing `*`
 * or `/` are treated as path globs; bare tokens are role IDs.
 *
 * Both inputs UNION — CLI doesn't replace workspace.
 */
export function resolveLkgOverrides(
  section: WorkspaceLkgConfig | undefined,
  cliFlags: { readonly skip?: readonly string[] },
): ResolvedLkgOverrides {
  const wsSkipRoles = section?.skip ?? [];
  const wsSkipPaths = section?.skipPaths ?? [];

  const cliSkipRoles: string[] = [];
  const cliSkipPaths: string[] = [];
  for (const s of cliFlags.skip ?? []) {
    if (s.includes('*') || s.includes('/')) cliSkipPaths.push(s);
    else cliSkipRoles.push(s);
  }

  const skipRoleIds = new Set([...wsSkipRoles, ...cliSkipRoles]);
  const skipPathGlobs = [...wsSkipPaths, ...cliSkipPaths];

  return {
    skipRoleIds,
    skipPathGlobs,
    shouldSkip(entry) {
      if (skipRoleIds.has(entry.roleId)) return true;
      for (const g of skipPathGlobs) {
        if (matchRuleIdGlob(g, entry.relPath)) return true;
      }
      return false;
    },
  };
}
