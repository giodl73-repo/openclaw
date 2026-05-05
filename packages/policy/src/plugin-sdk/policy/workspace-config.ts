/**
 * `workspace.json` policy section — the shape policy
 * reads from the universal config loader. Locally owned by this
 * package; oc-path has no upfront declaration of which
 * sections exist.
 *
 * Read pattern (in openclaw-policy CLI):
 *
 *   import { loadWorkspaceConfig } from '@openclaw/oc-path';
 *   import type { WorkspacePolicyConfig } from './workspace-config.js';
 *
 *   const cfg = await loadWorkspaceConfig(workspaceDir);
 *   const section = cfg?.['policy'] as WorkspacePolicyConfig | undefined;
 *   const generatorId = cliFlag ?? section?.generator ?? 'md';
 *
 * @module @openclaw/plugin-sdk/policy/workspace-config
 */

export interface WorkspacePolicyConfig {
  /**
   * Default generator id when `openclaw-policy generate` /
   * `openclaw-policy check` doesn't pass `--generator`. Falls back
   * to `'md'` if neither workspace.json nor CLI flag is set.
   */
  readonly generator?: string;
  /**
   * Default policy file path within the workspace. Falls back to
   * the conventional `POLICY_PATH` constant (`'policy.jsonc'`).
   */
  readonly policyPath?: string;
}
