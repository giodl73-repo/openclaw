/**
 * Companion file path conventions for the FS-backed LKG impl.
 *
 *   <path>      = the active file the tracker protects
 *   <path>.lkg  = companion holding the most-recent promoted-good bytes
 *   <path>.clobbered.<ts> = preserved bad bytes after a recovery event
 *
 * Mirrors the existing config-LKG shape so callers familiar with
 * `recoverConfigFromLastKnownGood` find the same on-disk layout.
 *
 * @module @openclaw/lkg-fs/paths
 */

const COMPANION_SUFFIX = '.lkg';
const CLOBBERED_PREFIX = '.clobbered.';
const LABEL_PREFIX = '.lkg.label.';
const LABEL_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** `<path>.lkg` — companion holding most-recent promoted-good bytes. */
export function lkgPathFor(activePath: string): string {
  return activePath + COMPANION_SUFFIX;
}

/**
 * `<path>.clobbered.<ts>` — preserved bad bytes after a recovery
 * event. `ts` is an ISO-8601 timestamp with `:` and `.` replaced
 * (filesystem-safe).
 */
export function clobberedPathFor(activePath: string, observedAt: string): string {
  const fsSafeTs = observedAt.replace(/[:.]/g, '-');
  return `${activePath}${CLOBBERED_PREFIX}${fsSafeTs}`;
}

/**
 * `<path>.lkg.label.<name>` — operator-pinned bytes for the
 * upgrade-recovery feature. Each labeled pin is its own immutable
 * companion file; rollback reads from here, writes to active path.
 *
 * Label names are restricted to `[A-Za-z0-9._-]+` to keep the
 * filename safe across platforms (no `/`, `:`, `\`, etc.).
 * Validation is the caller's job; this helper assumes a clean name.
 */
export function labeledPinPathFor(activePath: string, label: string): string {
  return `${activePath}${LABEL_PREFIX}${label}`;
}

/**
 * Operator-facing label-name validator. Returns true iff `name`
 * matches the allowed character set. Length-bounded too: ≥ 1, ≤ 64.
 */
export function isValidLabelName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 64) return false;
  return LABEL_NAME_RE.test(name);
}

/** True iff `path` is one of the LKG-managed companion files. */
export function isCompanionPath(path: string): boolean {
  return (
    path.endsWith(COMPANION_SUFFIX) ||
    path.includes(CLOBBERED_PREFIX) ||
    path.includes(LABEL_PREFIX)
  );
}
