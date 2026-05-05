/**
 * `workspace.json` doctor section — the shape oc-doctor reads
 * from the universal config loader. Locally owned by this package;
 * oc-path has no upfront declaration of which sections
 * exist.
 *
 * Read pattern (in a doctor CLI / host runner):
 *
 *   import { loadWorkspaceConfig } from '@openclaw/oc-path';
 *   import { resolveDoctorOverrides } from './workspace-config.js';
 *
 *   const cfg = await loadWorkspaceConfig(workspaceDir);
 *   const section = cfg?.['doctor'] as WorkspaceDoctorConfig | undefined;
 *   const disabled = resolveDoctorOverrides(section, cliFlags, registeredIds);
 *   // pass `disabled` to DoctorContext.disabledContributionIds
 *
 * @module @openclaw/oc-doctor/workspace-config
 */

import { matchRuleIdGlob } from '@openclaw/oc-path';

export interface WorkspaceDoctorConfig {
  /**
   * Doctor contribution IDs (or glob patterns) to skip. Matches
   * the same shape as the lint section's skip — entries can be
   * exact ids or globs that disable a whole namespace.
   *   skip: ["policy-starter-v0/tools/dedupe-tool-id"]
   *   skip: ["lkg-starter-v0/*"]   // disable a whole namespace
   */
  readonly skip?: readonly string[];
}

/**
 * Resolve effective doctor skip set from (a) workspace.json, (b)
 * CLI flag override. Returns the combined set of disabled
 * contribution IDs. Workspace globs are expanded against the
 * registered contribution-id list; CLI ids are exact additions.
 *
 * The doctor adapter consumes this via
 * `DoctorContext.disabledContributionIds`; matching contributions
 * skip detect entirely and skip fix with `{outcome: 'skipped',
 * reason: 'disabled'}`.
 */
export function resolveDoctorOverrides(
  section: WorkspaceDoctorConfig | undefined,
  cliFlags: { readonly skip?: readonly string[] },
  registeredContributionIds: readonly string[],
): ReadonlySet<string> {
  const disabled = new Set<string>();
  for (const glob of section?.skip ?? []) {
    for (const id of registeredContributionIds) {
      if (matchRuleIdGlob(glob, id)) disabled.add(id);
    }
  }
  for (const id of cliFlags.skip ?? []) disabled.add(id);
  return disabled;
}
