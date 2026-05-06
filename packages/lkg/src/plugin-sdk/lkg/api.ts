/**
 * `LKGStore` interface — the contract any backend implements.
 *
 * Plugins call `register(tracker)` to opt a path into LKG protection;
 * the host calls `observe(path, opts)` on every read or write to drive
 * the promote/observe/recover lifecycle.
 *
 * **Multi-tenant note**: the contract intentionally has NO `tenantId`
 * argument. Hosts instantiate one `LKGStore` per tenant scope; tracker
 * registration + observe happen against the tenant's store. Cross-
 * tenant collisions are structurally impossible (no shared mutable
 * state inside the store; no parameter that could be forgotten).
 *
 * @module @openclaw/plugin-sdk/lkg/api
 */

import type {
  LKGEntry,
  LKGFingerprint,
  LKGObservation,
  LKGObserveOptions,
  LKGTracker,
  ValidationIssue,
} from './types.js';

/**
 * Per-tracker outcome inside a `promoteAll` result.
 *
 * - `outcome: 'promoted'` — bytes were valid and the entry now
 *   carries this fingerprint as `lastPromotedGood`. If the call
 *   carried a label, the same fingerprint is also pinned under
 *   that label.
 * - `outcome: 'invalid'` — bytes did not validate. When `label`
 *   was set on the call, NO tracker is labeled (atomicity).
 * - `outcome: 'failed'` — read/parse/validate threw. Same all-or-
 *   nothing rule applies.
 */
export type PromoteAllTrackerOutcome =
  | { readonly path: string; readonly outcome: 'promoted'; readonly fingerprint: LKGFingerprint }
  | { readonly path: string; readonly outcome: 'invalid'; readonly reason: string }
  | { readonly path: string; readonly outcome: 'failed'; readonly reason: string };

export interface PromoteAllOptions {
  /**
   * Optional label to pin the promoted cohort under. If set, EVERY
   * tracker must be currently valid; otherwise `LKG_PROMOTE_TRACKER_INVALID`
   * is thrown and no labeling happens. The label itself must be
   * unused: re-pinning under an existing label throws
   * `LKG_LABEL_DUPLICATE`. Names must match `[A-Za-z0-9._-]+`.
   */
  readonly label?: string;
}

export interface PromoteAllResult {
  readonly trackers: readonly PromoteAllTrackerOutcome[];
  /** Same as `opts.label` if all trackers promoted; absent otherwise. */
  readonly label?: string;
  /** True iff every tracker outcome is 'promoted'. */
  readonly allValid: boolean;
}

/**
 * One row from `listLabels()` — describes a labeled pin from a
 * single tracker's perspective. A label that pinned 5 trackers
 * appears here as 5 rows.
 */
export interface LabelEntry {
  readonly label: string;
  readonly path: string;
  readonly fingerprint: LKGFingerprint;
}

export interface RollbackResult {
  readonly label: string;
  readonly restored: readonly { readonly path: string; readonly fingerprint: LKGFingerprint }[];
}

export interface DeleteLabelResult {
  readonly label: string;
  /** Per-tracker outcome of the delete: companion file path + whether the file was actually removed (it may have already been gone). */
  readonly removed: readonly { readonly path: string; readonly companionPath: string; readonly fileExisted: boolean }[];
}

export interface LKGStore {
  /**
   * Register a tracker. Backend rejects path collisions with
   * `LKG_TRACKER_PATH_COLLISION` and out-of-root paths with
   * `LKG_TRACKER_PATH_INVALID`.
   */
  register<TParsed, TIssue = ValidationIssue>(
    tracker: LKGTracker<TParsed, TIssue>,
  ): void;

  /**
   * Observe a tracked path. Reads bytes from disk, computes
   * fingerprint, parses, validates, and either promotes (valid),
   * recovers (invalid + LKG available), or skips (no LKG / plugin-
   * local invalidity).
   *
   * The optional `opts.actor` and `opts.correlationEventId` flow into
   * the recovery observation's forensic fields when recovery happens.
   */
  observe(path: string, opts?: LKGObserveOptions): Promise<LKGObservation>;

  /**
   * Read the most-recent promoted-good bytes for a tracked path.
   * Used by consumers (PolicyIR, hook-output recovery) to re-load
   * after a recovery event without re-walking the recovery flow.
   *
   * Throws `LKGError(LKG_STORE_UNAVAILABLE)` if no LKG has been
   * promoted yet for `path`. Throws `LKGError(LKG_ABORTED)` if the
   * caller's signal is already aborted.
   */
  readLastKnownGood(path: string, opts?: LKGObserveOptions): Promise<Uint8Array>;

  /**
   * Look up the entry record for a tracked path. Returns `null` if
   * the path is registered but no observation has produced an entry
   * yet (initial state).
   */
  getEntry(path: string): LKGEntry | null;

  /**
   * List every path the store has promoted bytes for. Returns just
   * the path keys — operators wanting per-entry detail (fingerprint,
   * label map) call `getEntry(path)` on the ones they care about.
   *
   * Used by `cage status` for ORPHAN detection (set-diff: tracked-here
   * minus reachable-from-manifest-walk). Returning paths only avoids
   * shipping the labels map for entries we're about to discard.
   *
   * Backend-specific freshness:
   * - FS impl: lazy-loads state from `<root>/.openclaw/lkg-health.json`.
   * - Git impl: returns the in-process tracker cache (entries hydrate
   *   on first `register` / `observe`).
   *
   * Future: a `{label?}` filter could scope to a cohort for upgrade
   * scenarios. Not added now — the only consumer (orphan detection)
   * doesn't need it.
   */
  listPaths(): Promise<readonly string[]>;

  /**
   * Workspace-wide promote. Observes every registered tracker,
   * promotes each that validates, and (if a label was passed) pins
   * the cohort atomically: ALL trackers must be valid, else NOTHING
   * is labeled. Operator's "this state is good" verb — backs the
   * pre-upgrade-snapshot use case described in upstream issue #14526.
   *
   * Backend behavior:
   * - FS impl: writes a `<path>.lkg.label.<name>` companion per
   *   tracker; persists the label inside the entry record.
   * - Git impl: creates a `lkg/<name>` git tag at HEAD after the
   *   labeled cohort is committed.
   *
   * Throws `LKGError(LKG_LABEL_INVALID_NAME)` if the label has
   * forbidden characters; `LKG_LABEL_DUPLICATE` if it's already used
   * by any tracker; `LKG_PROMOTE_TRACKER_INVALID` if any tracker
   * fails validate (no labeling happens).
   */
  promoteAll(opts?: PromoteAllOptions): Promise<PromoteAllResult>;

  /**
   * List every labeled pin across every registered tracker.
   * Operator-facing inventory: "what labels have I created and what
   * do they pin?"
   *
   * Async because some backends (git) query the underlying VCS;
   * FS-backed impls return synchronously from in-memory state.
   */
  listLabels(): Promise<readonly LabelEntry[]>;

  /**
   * Atomically restore every tracked path back to the bytes pinned
   * under `label`. Two-phase:
   *   1. Verify every tracker has this label and the companion
   *      bytes still match the recorded hash. If any tracker is
   *      missing the label or the companion is tampered, throws
   *      `LKG_ROLLBACK_VERIFY_FAILED` and no writes happen.
   *   2. Write each tracker's labeled bytes to its active path.
   *
   * Throws `LKGError(LKG_LABEL_NOT_FOUND)` if no tracker carries
   * this label.
   */
  rollbackToLabel(label: string, opts?: LKGObserveOptions): Promise<RollbackResult>;

  /**
   * Delete a label. The escape hatch for immutable labels: operators
   * who are confident an upgrade stuck (or who want to reuse a label
   * name) call this to free disk space and unblock re-pinning.
   *
   * Backend behavior:
   * - FS impl: removes every `<path>.lkg.label.<name>` companion and
   *   the `entry.labels[name]` metadata. State file is rewritten.
   * - Git impl: `git tag -d lkg/<name>`. The tagged commit's blobs
   *   are still in the repo's object store (eligible for `git gc`
   *   after the tag is gone).
   *
   * Throws `LKGError(LKG_LABEL_NOT_FOUND)` if no tracker carries
   * this label. Idempotent against partial state: if some companions
   * are already gone, reports `fileExisted: false` for those rows
   * and continues — the goal is "after this returns, the label is
   * cleanly gone."
   */
  deleteLabel(label: string): Promise<DeleteLabelResult>;
}
