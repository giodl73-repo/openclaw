/**
 * `@openclaw/oc-path/workspace` — manifest layer that assigns every
 * canonical openclaw artifact its `oc://...` URI.
 *
 * Single-import for "what's in this workspace, addressed by oc-path":
 *
 *   import { buildWorkspaceManifest } from '@openclaw/oc-path/workspace';
 *
 *   const manifest = await buildWorkspaceManifest('/abs/workspace');
 *   for (const entry of manifest.entries) {
 *     console.log(entry.ocPathString, entry.role.id);
 *     // → oc://AGENTS.md  agents.md
 *     // → oc://gateway.jsonc  config.jsonc
 *     // → oc://sessions/session.jsonl  session.jsonl
 *   }
 *
 * @module @openclaw/oc-path/workspace
 */

export {
  OPENCLAW_WORKSPACE_ROLES,
  roleForBasename,
  type OpenClawWorkspaceRole,
} from './roles.js';
export {
  buildWorkspaceManifest,
  type BuildWorkspaceManifestOptions,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
} from './manifest.js';
export {
  WORKSPACE_CONFIG_PATH,
  filterByOnlyGlobs,
  loadWorkspaceConfig,
  matchRuleIdGlob,
  type WorkspaceConfig,
} from './config.js';
