/**
 * Workspace manifest builder — walks a workspace directory and
 * assigns every canonical openclaw artifact its `oc://...` URI.
 *
 * In-memory only: no on-disk manifest format, no canonical filename
 * to defend with maintainers. Built dynamically from the directory
 * + the role list from `./roles.js`. Consumers (oc-lint host walker,
 * oc-doctor host walker, lkg-recovery's `registerOpenClawWorkspace`,
 * gateway config loaders) all read the same manifest so a single
 * walk feeds the whole toolchain.
 *
 * @module @openclaw/oc-path/workspace/manifest
 */

import { promises as fs, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { OcKind } from '../dispatch.js';
import { parseOcPath, type OcPath } from '../oc-path.js';
import { OPENCLAW_WORKSPACE_ROLES, type OpenClawWorkspaceRole } from './roles.js';

/**
 * Bound on directory recursion depth. Mirrors `MAX_TRAVERSAL_DEPTH`
 * from oc-path; real workspaces don't nest beyond ~10 levels, so 256
 * is a safe ceiling that still protects against pathological input
 * (deep symlink chains, deliberate stack-blowing trees).
 */
const MAX_WALK_DEPTH = 256;

/**
 * Tightened companion-suffix matcher. The LKG store's
 * `clobberedPathFor` produces names like
 * `<original>.clobbered.<isoTimestamp-with-dashes>`, which always
 * starts with `.clobbered.YYYY-MM-DD`. Anchoring on the date prefix
 * avoids dropping legitimate files like `data.clobbered.test.md`.
 */
const CLOBBERED_SUFFIX_RE = /\.clobbered\.\d{4}-\d{2}-\d{2}/;

/**
 * One entry in the workspace manifest — a canonical openclaw artifact
 * with its filesystem path, workspace-relative path, role, and the
 * derived `oc://...` URI for cross-substrate addressing.
 */
export interface WorkspaceManifestEntry {
  /** Absolute filesystem path. */
  readonly path: string;
  /** Workspace-relative path with forward slashes. */
  readonly relPath: string;
  /** Role this file plays in the openclaw toolchain. */
  readonly role: OpenClawWorkspaceRole;
  /** Structured oc:// path object — `{ file: relPath }`. */
  readonly ocPath: OcPath;
  /** String form of the oc:// URI — `oc://<relPath>`. */
  readonly ocPathString: string;
}

export interface WorkspaceManifest {
  /** Files matched to canonical openclaw roles, in walk order. */
  readonly entries: readonly WorkspaceManifestEntry[];
  /** Total files traversed before role matching (excludes companions + skipped dirs). */
  readonly walkedFiles: number;
  /** Count of registered files per kind. */
  readonly byKind: Readonly<Record<OcKind, number>>;
  /** Count of registered files per role id. */
  readonly byRole: Readonly<Record<string, number>>;
}

const DEFAULT_SKIP_DIR_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
];

export interface BuildWorkspaceManifestOptions {
  /**
   * Additional roles for files outside the canonical openclaw set.
   * Each role still needs a basename matcher and a kind.
   */
  readonly extraRoles?: readonly OpenClawWorkspaceRole[];
  /** Cancel a long-running walk via `AbortController.signal`. */
  readonly signal?: AbortSignal;
  /**
   * Directory basenames to skip during the walk. Defaults to common
   * VCS / build artifacts. Override completely (no merge); pass an
   * empty array to walk everything.
   */
  readonly skipDirNames?: readonly string[];
}

/**
 * Walk `workspaceDir` and return the in-memory manifest. Companion
 * files (`.lkg`, `.clobbered.<ts>`) are filtered out unconditionally;
 * non-canonical files (random README, package.json, etc.) are walked
 * but not entered into the manifest.
 *
 * Callers handle parsing themselves — the manifest is a metadata
 * layer (paths + roles + ocPaths). Consumers that need ASTs (lint,
 * doctor) read each entry's bytes and dispatch on `entry.role.kind`.
 * Consumers that don't (LKG, gateway loader) skip the parse step.
 */
export async function buildWorkspaceManifest(
  workspaceDir: string,
  opts: BuildWorkspaceManifestOptions = {},
): Promise<WorkspaceManifest> {
  const roles = [...OPENCLAW_WORKSPACE_ROLES, ...(opts.extraRoles ?? [])];
  const skipDirs = new Set(opts.skipDirNames ?? DEFAULT_SKIP_DIR_NAMES);

  const entries: WorkspaceManifestEntry[] = [];
  let walkedFiles = 0;

  await walkDirectory(workspaceDir, async (fullPath, dirent) => {
    if (opts.signal?.aborted) return;
    walkedFiles++;
    // Companion files are LKG-managed, never workspace-canonical.
    if (dirent.name.endsWith('.lkg') || CLOBBERED_SUFFIX_RE.test(dirent.name)) {
      return;
    }
    // Custom matchers (via extraRoles) must not crash the walk —
    // wrap each invocation so a thrown predicate behaves like "no
    // match" rather than aborting the whole manifest build.
    const role = findMatchingRole(dirent.name, roles);
    if (role === null) return;

    const relPath = relative(workspaceDir, fullPath).replace(/\\/g, '/');
    const ocPathString = `oc://${relPath}`;
    // Validate the synthesized URI through parseOcPath. Pathological
    // filenames (containing `?`, control chars, exceeding length cap,
    // etc.) would produce a string the rest of the toolchain can't
    // parse, so we drop them from the manifest rather than silently
    // shipping broken oc:// URIs to consumers.
    let ocPath: OcPath;
    try {
      ocPath = parseOcPath(ocPathString);
    } catch {
      return;
    }
    entries.push({ path: fullPath, relPath, role, ocPath, ocPathString });
  }, skipDirs, opts.signal, 0);

  const byKind: Record<OcKind, number> = { md: 0, jsonc: 0, jsonl: 0, yaml: 0 };
  const byRole: Record<string, number> = {};
  for (const entry of entries) {
    byKind[entry.role.kind]++;
    byRole[entry.role.id] = (byRole[entry.role.id] ?? 0) + 1;
  }

  return { entries, walkedFiles, byKind, byRole };
}

async function walkDirectory(
  dir: string,
  onFile: (fullPath: string, dirent: Dirent) => Promise<void>,
  skipDirs: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<void> {
  if (signal?.aborted) return;
  // Bound recursion. A workspace nested deeper than MAX_WALK_DEPTH is
  // either malformed or hostile; either way, refusing to descend
  // further is safer than blowing the stack.
  if (depth > MAX_WALK_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Permission denied / disappearing dir — silently skip. The
    // manifest's contract is "best-effort tour of the workspace,"
    // not "strict filesystem audit."
    return;
  }
  for (const dirent of entries) {
    if (signal?.aborted) return;
    const fullPath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (skipDirs.has(dirent.name)) continue;
      await walkDirectory(fullPath, onFile, skipDirs, signal, depth + 1);
      continue;
    }
    // Symlinks have neither isDirectory() nor isFile() returning true
    // (Dirent reports the entry's own type, not the target's). We
    // intentionally don't follow them — symlinks pointing outside the
    // workspace are a path-traversal risk, and symlink loops would
    // break the depth bound. Callers that need symlink semantics
    // should resolve their workspace root before calling this builder.
    if (dirent.isFile()) {
      await onFile(fullPath, dirent);
    }
  }
}

/**
 * Find the first role whose `matchesBasename` predicate returns true,
 * with each call wrapped in try/catch so a thrown custom matcher
 * behaves like "no match" rather than crashing the whole walk.
 *
 * Canonical roles are checked before extraRoles, so canonical role
 * matchers always win on overlap (extraRoles cannot override
 * canonical role assignments).
 */
function findMatchingRole(
  basename: string,
  roles: readonly OpenClawWorkspaceRole[],
): OpenClawWorkspaceRole | null {
  for (const role of roles) {
    try {
      if (role.matchesBasename(basename)) return role;
    } catch {
      continue;
    }
  }
  return null;
}
