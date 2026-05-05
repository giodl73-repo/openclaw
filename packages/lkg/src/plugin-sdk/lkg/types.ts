import type { OcPath } from '@openclaw/oc-path';

/**
 * `@openclaw/plugin-sdk/lkg` — type contract for the generalized
 * Last-Known-Good substrate.
 *
 * Generalizes the existing `recoverConfigFromLastKnownGood` mechanism
 * (shipped at commit `af56926e2fc4` for issue #70528, v2026.4.23) so
 * any plugin can register against it. The same `.lkg` companion file
 * shape, the same `.clobbered.<ts>` preservation, the same audit
 * envelope — just parameterized over a tracker any plugin can register.
 *
 * **Type-shape decisions**:
 *
 *   1. `LKGFingerprint` is BACKEND-AGNOSTIC. POSIX stat fields move
 *      into the optional `fsStat?` appendix; non-FS backends (git,
 *      HTTP, object-store) omit it entirely.
 *
 *   2. `LKGTracker` carries TWO type parameters: `TParsed` for the
 *      tracker's parsed value type AND `TIssue` for the tracker's
 *      issue vocabulary. Trackers with rich domain-specific issues
 *      (e.g., PolicyIR's structured violations) don't downcast through
 *      `ValidationIssue`.
 *
 *   3. `LKGObservation.recovered` carries SIEM-stitchable forensic
 *      fields: `replacedFingerprint`, `clobberedFileHash`, `actor`,
 *      `correlationEventId`. The host passes actor/correlationEventId
 *      through `LKGObserveOptions`.
 *
 *   4. Optional `attestation?` slot on `LKGFingerprint` for compliance-
 *      grade deployments (SOC 2 §CC6.1, FedRAMP AU-10). Backend-
 *      defined: Sigstore bundle, gpg detached sig, ed25519, JWS, etc.
 *      Default impls leave it `null`.
 *
 * @module @openclaw/plugin-sdk/lkg
 */

// --- Fingerprint: universal core + optional FS appendix ---------------------

/**
 * Backend-agnostic fingerprint. Every `LKGStore` impl produces these
 * fields. `hash` is the bytes-only digest (sha256 over raw bytes for
 * filesystem; blob-sha for git-backed; could be a server-side ETag for
 * an HTTP/object-store impl).
 */
export interface LKGFingerprint {
  readonly hash: string;
  readonly bytes: number;
  /** ISO-8601 UTC timestamp the fingerprint was computed. */
  readonly observedAt: string;
  /**
   * Optional backend-specific signature over `(hash, observedAt)`.
   * Compliance-grade deployments require non-empty; default impls
   * leave `null`. Backend-defined format (Sigstore / gpg / ed25519 /
   * JWS / etc.).
   */
  readonly attestation?: string | null;
  /** Filesystem-only stat appendix; absent for non-FS backends. */
  readonly fsStat?: LKGFsStat;
}

/**
 * POSIX stat fields. Only meaningful for filesystem-backed impls;
 * git, HTTP, and object-store backends omit this entirely. Earlier
 * drafts inlined these on `LKGFingerprint`, leaking POSIX assumptions
 * into the universal contract.
 */
export interface LKGFsStat {
  readonly mtimeMs: number | null;
  readonly ctimeMs: number | null;
  readonly dev: string | null;
  readonly ino: string | null;
  readonly mode: number | null;
  readonly nlink: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
}

/**
 * What the LKG store remembers about a tracked path: the most-recent
 * known-good fingerprint, the most-recent promoted-good fingerprint,
 * and a hash of the most-recent suspicious-but-not-corrupt observation
 * (used to dedupe repeated suspicious notifications).
 *
 * `labels`: operator-named pins for upgrade-recovery. Set via
 * `promoteAll({ label })`; the bytes are preserved in a companion file
 * adjacent to the tracked path (FS impl: `<path>.lkg.label.<name>`).
 * Labels are IMMUTABLE — re-promoting with the same label throws
 * `LKG_LABEL_DUPLICATE`. Operator must explicitly delete a label
 * before rebinding it. Listed via `listLabels()`, restored via
 * `rollbackToLabel(name)`.
 */
export interface LKGEntry {
  readonly lastKnownGood?: LKGFingerprint;
  readonly lastPromotedGood?: LKGFingerprint;
  readonly lastObservedSuspiciousSignature?: string | null;
  readonly labels?: Readonly<Record<string, LKGFingerprint>>;
}

// --- Validation: tracker-typed parsed value AND tracker-typed issues --------

/**
 * Default issue shape. Trackers with richer issue vocabularies
 * parameterize `ValidationResult<TIssue>` and `LKGTracker<_, TIssue>`
 * over their own type.
 */
export interface ValidationIssue {
  /** Dotted path to the offending field (e.g., "plugins.entries.foo.kind"). */
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ValidationResult<TIssue = ValidationIssue> {
  readonly valid: boolean;
  readonly issues: readonly TIssue[];
}

/**
 * A registered tracker. The store calls `parse` on raw bytes from
 * disk, then `validate` on the parsed result. Optional hooks let the
 * tracker declare suspicious-but-recoverable inputs and exempt
 * plugin-local invalidity from whole-file recovery.
 *
 * Mirrors the shape of the existing config-LKG validator in
 * `recoverConfigFromLastKnownGood`; first reference consumer is the
 * config tracker that migrates to this contract in PR-1.
 */
export interface LKGTracker<TParsed = unknown, TIssue = ValidationIssue> {
  /** Absolute filesystem path the tracker protects. */
  readonly path: string;
  /**
   * Optional workspace-relative `oc://` address for the tracked file.
   * Decouples tracker identity from deployment-specific filesystem
   * paths: audit events synthesize a portable `ocPath` field from
   * this; consumers can correlate LKG events with oc-lint / oc-doctor
   * diagnostics that already use the same vocabulary.
   *
   * When omitted, audit events carry only the filesystem `path`.
   * In-tree trackers SHOULD declare this; external plugins MAY.
   */
  readonly ocPath?: OcPath;
  /**
   * SDK-version compatibility hint. Plugins authored against a known
   * SDK version declare it here; the host warns on major-version
   * mismatch with `SDK_VERSION`. Optional — omitting it means "trust
   * the host," which is the right default for in-tree trackers that
   * ship with the SDK.
   */
  readonly requires?: {
    readonly sdkVersion: string;
  };
  parse(raw: string): TParsed;
  validate(parsed: TParsed): ValidationResult<TIssue>;
  /**
   * Optional: validates-but-feels-wrong heuristics (size dropped, meta
   * missing, etc.). Returns reason strings; empty array means "no
   * suspicion."
   */
  suspiciousReasons?(args: {
    current: LKGFingerprint;
    lastKnownGood: LKGFingerprint;
    parsed: TParsed;
  }): readonly string[];
  /**
   * Optional: skip whole-file recovery for plugin-local invalidity.
   * Mirrors upstream's `recovery-policy.ts:isPluginLocalInvalidConfigSnapshot`.
   * Returning `false` short-circuits recovery; the runtime degrades
   * around the broken portion instead.
   *
   * The `parsed` field carries the tracker's own parse output —
   * trackers using oc-paths AST as `TParsed` can run `findOcPaths`
   * inside the heuristic for richer queries (e.g., "the broken
   * field is under `oc://config/plugins.entries.*`, treat as
   * plugin-local").
   */
  shouldRecover?(snapshot: {
    valid: boolean;
    issues: readonly TIssue[];
    parsed: TParsed;
  }): boolean;
}

// --- Actor + observe options ------------------------------------------------

/**
 * Best-effort attribution for a recovery event. The host populates
 * this via `observe(path, { actor })`; the store does not invent it.
 */
export interface LKGActor {
  readonly kind: 'plugin' | 'hook' | 'agent-session' | 'host';
  readonly id: string;
  readonly pid?: number;
}

export interface LKGObserveOptions {
  readonly actor?: LKGActor;
  /** Opaque ID the host stitches with its own audit pipeline (request-id, trace-id, gateway turn-id). */
  readonly correlationEventId?: string;
  /**
   * Optional cancellation signal. The store checks `signal.aborted`
   * at every I/O boundary inside `observe()` (read, parse, validate,
   * promote-write, recover-write). On abort, returns
   * `{outcome: 'failed', reason: 'aborted'}` rather than throwing —
   * partial observation results are recorded in audit so the
   * pipeline isn't silent on cancel.
   *
   * `readLastKnownGood()` honors the same signal (single read; aborts
   * before fs.readFile if already cancelled).
   */
  readonly signal?: AbortSignal;
}

// --- Observation: forensics on every recovery -------------------------------

/**
 * Every observation outcome carries an optional `ocPath` field —
 * the formatted `oc://` URI for the tracked file, synthesized by
 * the store from `LKGTracker.ocPath`. Absent if the tracker didn't
 * declare an ocPath. Lets SIEM / observability pipelines correlate
 * LKG events with oc-lint / oc-doctor diagnostics that already use
 * the same vocabulary.
 */
export type LKGObservation<TIssue = ValidationIssue> =
  | { readonly outcome: 'valid'; readonly fingerprint: LKGFingerprint; readonly ocPath?: string }
  | { readonly outcome: 'promoted'; readonly fingerprint: LKGFingerprint; readonly ocPath?: string }
  | {
      readonly outcome: 'recovered';
      readonly reason: string;
      readonly clobberedPath: string;
      /** sha256 of clobberedPath after the swap; lets forensics correlate without re-hashing. */
      readonly clobberedFileHash: string;
      readonly restoredFrom: LKGFingerprint;
      /** What was on disk just before the swap (the bad bytes that triggered recovery). */
      readonly replacedFingerprint: LKGFingerprint | null;
      readonly actor?: LKGActor | null;
      readonly correlationEventId?: string | null;
      readonly ocPath?: string;
    }
  | {
      readonly outcome: 'skipped';
      readonly reason: 'plugin-local-invalidity' | 'no-lkg-available' | 'tracker-shouldRecover-false';
      readonly issues: readonly TIssue[];
      readonly ocPath?: string;
    }
  | {
      readonly outcome: 'failed';
      readonly reason: string;
      readonly issues: readonly TIssue[];
      readonly ocPath?: string;
    };

// --- Errors -----------------------------------------------------------------

export type LKGErrorCode =
  | 'LKG_TRACKER_PATH_COLLISION'
  | 'LKG_TRACKER_PATH_INVALID'
  | 'LKG_STORE_UNAVAILABLE'
  | 'LKG_VALIDATOR_THREW'
  | 'LKG_ABORTED'
  | 'LKG_INTERNAL'
  // State-file persistence errors — emitted by `FsLKGStore` when the
  // on-disk `lkg-health.json` is unreadable, malformed, or written
  // by a future schema version.
  | 'LKG_STATE_FILE_READ_FAILED'
  | 'LKG_STATE_FILE_CORRUPT'
  | 'LKG_STATE_FILE_VERSION_MISMATCH'
  // Label / rollback errors (upgrade-recovery feature).
  | 'LKG_LABEL_INVALID_NAME'      // label name has forbidden chars; only [A-Za-z0-9._-] allowed
  | 'LKG_LABEL_DUPLICATE'         // promoting with a label that already exists; immutable
  | 'LKG_LABEL_NOT_FOUND'         // rollback to a label that no tracker has pinned
  | 'LKG_PROMOTE_TRACKER_INVALID' // promoteAll refused: at least one tracker not currently valid
  | 'LKG_ROLLBACK_VERIFY_FAILED'; // rollback aborted in phase-1: companion missing or hash mismatch

export class LKGError extends Error {
  readonly code: LKGErrorCode;
  readonly path?: string;

  constructor(code: LKGErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'LKGError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
