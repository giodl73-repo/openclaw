/**
 * Opinionated LKG registrar for the openclaw artifact set.
 *
 * Thin layer on top of `buildWorkspaceManifest` from oc-paths-
 * substrate: takes the manifest entries (or a workspace dir to walk
 * fresh), looks up the right per-kind tracker factory, and registers
 * each entry with the store.
 *
 * Why this is thin: the manifest is the canonical "what's in this
 * workspace, addressed by oc-path" layer. LKG's only job here is to
 * map manifest entries → trackers. Lint, doctor, and gateway loaders
 * read the SAME manifest for their own purposes — one walk, four
 * happy consumers.
 *
 *   import { buildWorkspaceManifest } from '@openclaw/oc-path';
 *   import { FsLKGStore } from '@openclaw/lkg/fs';
 *   import { registerOpenClawWorkspace } from '@openclaw/lkg/trackers';
 *
 *   const manifest = await buildWorkspaceManifest(workspaceDir);
 *   const store = new FsLKGStore({ root: workspaceDir });
 *   const result = registerOpenClawWorkspace(store, manifest);
 *
 * @module @openclaw/lkg/trackers/openclaw-workspace
 */

import type {
  BuildWorkspaceManifestOptions,
  OcKind,
  OcPath,
  OpenClawWorkspaceRole,
  WorkspaceManifest,
  WorkspaceManifestEntry,
} from '@openclaw/oc-path';
import { buildWorkspaceManifest } from '@openclaw/oc-path';
import type { LKGStore } from '../plugin-sdk/lkg/api.js';
import { LKGError, type LKGTracker } from '../plugin-sdk/lkg/types.js';
import { jsoncTracker } from './jsonc.js';
import { jsonlTracker } from './jsonl.js';
import { mdTracker } from './md.js';
import { yamlTracker } from './yaml.js';

export interface OpenClawRegisteredEntry {
  /** Absolute filesystem path. */
  readonly path: string;
  /** Workspace-relative path with forward slashes. */
  readonly relPath: string;
  /** Role this file plays in openclaw. */
  readonly role: OpenClawWorkspaceRole;
  /** Synthesized `oc://...` URI for the file. */
  readonly ocPath: string;
}

export interface OpenClawSkippedEntry {
  readonly path: string;
  readonly reason: 'collision' | 'register-failed';
  readonly detail?: string;
}

export interface RegisterOpenClawWorkspaceResult {
  readonly registered: readonly OpenClawRegisteredEntry[];
  readonly skipped: readonly OpenClawSkippedEntry[];
  readonly byKind: Readonly<Record<OcKind, number>>;
  readonly byRole: Readonly<Record<string, number>>;
}

/**
 * Register an LKGTracker for every manifest entry. Idempotent in
 * the sense that re-registering an already-registered path produces
 * a `'collision'` skip (not a throw).
 */
export function registerOpenClawWorkspace(
  store: LKGStore,
  manifest: WorkspaceManifest,
): RegisterOpenClawWorkspaceResult {
  const registered: OpenClawRegisteredEntry[] = [];
  const skipped: OpenClawSkippedEntry[] = [];

  for (const entry of manifest.entries) {
    const tracker = buildTracker(entry.role.kind, entry.path, entry.ocPath);
    if (tracker === null) {
      skipped.push({
        path: entry.path,
        reason: 'register-failed',
        detail: `unknown kind: ${entry.role.kind}`,
      });
      continue;
    }
    try {
      store.register(tracker);
      registered.push({
        path: entry.path,
        relPath: entry.relPath,
        role: entry.role,
        ocPath: entry.ocPathString,
      });
    } catch (err) {
      if (err instanceof LKGError && err.code === 'LKG_TRACKER_PATH_COLLISION') {
        skipped.push({ path: entry.path, reason: 'collision' });
        continue;
      }
      skipped.push({
        path: entry.path,
        reason: 'register-failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const byKind: Record<OcKind, number> = { md: 0, jsonc: 0, jsonl: 0, yaml: 0 };
  const byRole: Record<string, number> = {};
  for (const r of registered) {
    byKind[r.role.kind]++;
    byRole[r.role.id] = (byRole[r.role.id] ?? 0) + 1;
  }
  return { registered, skipped, byKind, byRole };
}

/**
 * Convenience: walk the workspace and register in one call. Equivalent
 * to `buildWorkspaceManifest(dir, opts)` followed by
 * `registerOpenClawWorkspace(store, manifest)`. For callers that need
 * the manifest for other purposes (feeding lint or doctor in the same
 * run), use the two-step form instead.
 */
export async function registerOpenClawWorkspaceFromDir(
  store: LKGStore,
  workspaceDir: string,
  opts: BuildWorkspaceManifestOptions = {},
): Promise<RegisterOpenClawWorkspaceResult & { manifest: WorkspaceManifest }> {
  const manifest = await buildWorkspaceManifest(workspaceDir, opts);
  const result = registerOpenClawWorkspace(store, manifest);
  return { ...result, manifest };
}

function buildTracker(
  kind: OcKind,
  path: string,
  ocPath: OcPath,
): LKGTracker<unknown> | null {
  switch (kind) {
    case 'md':
      return mdTracker({ path, ocPath }) as LKGTracker<unknown>;
    case 'jsonc':
      return jsoncTracker({ path, ocPath }) as LKGTracker<unknown>;
    case 'jsonl':
      return jsonlTracker({ path, ocPath }) as LKGTracker<unknown>;
    case 'yaml':
      return yamlTracker({ path, ocPath }) as LKGTracker<unknown>;
    default:
      return null;
  }
}

// Re-export the manifest types for callers that import only from
// `lkg/trackers` and don't want a second import
// path.
export type {
  WorkspaceManifest,
  WorkspaceManifestEntry,
  OpenClawWorkspaceRole,
};
export { buildWorkspaceManifest };
