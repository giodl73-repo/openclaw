/**
 * `FsLKGStore` — the reference filesystem-backed `LKGStore` impl.
 *
 * Lifecycle per `observe(path, opts)`:
 *
 *   1. Read bytes from disk + stat.
 *   2. Compute fingerprint.
 *   3. parse + validate via the registered tracker.
 *   4. Branch on outcome:
 *        valid     → if fingerprint != lastPromotedGood, PROMOTE
 *                    (write `.lkg` companion). Return outcome:
 *                    'promoted' on first valid; 'valid' on no-change.
 *        invalid   → if shouldRecover() returns false: outcome
 *                    'skipped' / 'plugin-local-invalidity'.
 *                    Else if no LKG: outcome 'skipped' /
 *                    'no-lkg-available'.
 *                    Else RECOVER: write bad bytes to
 *                    `.clobbered.<ts>`, copy `.lkg` back to active
 *                    path, audit, enqueue recovery notice.
 *
 * Multi-tenant: instantiate one `FsLKGStore` per tenant scope. The
 * store rejects tracker paths outside its configured root.
 *
 * @module @openclaw/lkg-fs/store
 */

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { REDACTED_SENTINEL, formatOcPath } from '@openclaw/oc-path';
import type {
  LKGEntry,
  LKGFingerprint,
  LKGObservation,
  LKGObserveOptions,
  LKGTracker,
  ValidationIssue,
} from '../../plugin-sdk/lkg/types.js';
import { LKGError } from '../../plugin-sdk/lkg/types.js';
import type {
  DeleteLabelResult,
  LKGStore,
  LabelEntry,
  PromoteAllOptions,
  PromoteAllResult,
  PromoteAllTrackerOutcome,
  RollbackResult,
} from '../../plugin-sdk/lkg/api.js';
import { InMemoryAuditSink, type LKGAuditSink } from './audit.js';
import { makeFingerprint, hashRaw } from './fingerprint.js';
import {
  clobberedPathFor,
  isValidLabelName,
  labeledPinPathFor,
  lkgPathFor,
} from './paths.js';
import {
  InMemoryRecoveryNoticeSink,
  type LKGRecoveryNoticeSink,
} from './recovery-notice.js';

export interface FsLKGStoreOptions {
  /** Absolute filesystem root the store manages. Trackers must register paths inside this root. */
  readonly root: string;
  /** Reject tracker paths outside `root` (default: true). */
  readonly forbidPathsOutsideRoot?: boolean;
  readonly auditSink?: LKGAuditSink;
  readonly recoveryNoticeSink?: LKGRecoveryNoticeSink;
  /**
   * For deterministic tests: override the "now" timestamp generator.
   * Production passes `() => new Date().toISOString()` (the default).
   */
  readonly nowIso?: () => string;
  /**
   * Absolute path to the state file that persists `entries` across
   * process restarts. Default: `<root>/.openclaw/lkg-health.json`.
   * Mirrors upstream's existing `<root>/.openclaw/config-health.json`
   * convention.
   *
   * `null` disables persistence entirely (in-memory only). Tests
   * use `null` for the deterministic surface; production hosts
   * leave the default so observations survive restarts.
   */
  readonly stateFile?: string | null;
}

/** On-disk shape of the state file. Bumped on breaking changes. */
interface PersistedState {
  readonly version: '0.1.0';
  readonly entries: Readonly<Record<string, LKGEntry>>;
}

export class FsLKGStore implements LKGStore {
  private readonly trackers = new Map<string, LKGTracker<unknown, ValidationIssue>>();
  private readonly entries = new Map<string, LKGEntry>();
  private readonly root: string;
  private readonly forbidOutside: boolean;
  private readonly auditSink: LKGAuditSink;
  private readonly noticeSink: LKGRecoveryNoticeSink;
  private readonly nowIso: () => string;
  private readonly stateFile: string | null;
  /** Lazily loaded on first observe; null after explicit `disable`. */
  private stateLoaded = false;

  constructor(opts: FsLKGStoreOptions) {
    this.root = resolve(opts.root);
    this.forbidOutside = opts.forbidPathsOutsideRoot ?? true;
    this.auditSink = opts.auditSink ?? new InMemoryAuditSink();
    this.noticeSink = opts.recoveryNoticeSink ?? new InMemoryRecoveryNoticeSink();
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    // Default state file at <root>/.openclaw/lkg-health.json — mirrors
    // upstream's config-health.json convention. Tests pass `null` to
    // disable persistence and stay deterministic-in-memory.
    if (opts.stateFile === null) {
      this.stateFile = null;
    } else if (opts.stateFile !== undefined) {
      this.stateFile = opts.stateFile;
    } else {
      this.stateFile = resolve(this.root, '.openclaw', 'lkg-health.json');
    }
  }

  /**
   * Load persisted entries from `stateFile` into the in-memory map
   * (idempotent — does nothing on repeat calls). Called lazily on
   * first observe() so the store cost is zero for callers that
   * never use it.
   *
   * Missing state file is not an error — fresh deployments start
   * with an empty `entries` map. Malformed state file throws
   * `LKG_STATE_FILE_CORRUPT`.
   */
  private async loadStateOnce(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (this.stateFile === null) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.stateFile, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // fresh deployment
      throw new LKGError(
        'LKG_STATE_FILE_READ_FAILED',
        `state file read failed at ${this.stateFile}: ${(err as Error).message}`,
        this.stateFile,
      );
    }
    let parsed: PersistedState;
    try {
      parsed = JSON.parse(raw) as PersistedState;
    } catch (err) {
      throw new LKGError(
        'LKG_STATE_FILE_CORRUPT',
        `state file parse failed at ${this.stateFile}: ${(err as Error).message}`,
        this.stateFile,
      );
    }
    if (parsed.version !== '0.1.0') {
      throw new LKGError(
        'LKG_STATE_FILE_VERSION_MISMATCH',
        `state file version ${parsed.version} unsupported by this build (expected 0.1.0)`,
        this.stateFile,
      );
    }
    for (const [path, entry] of Object.entries(parsed.entries)) {
      this.entries.set(path, entry);
    }
  }

  /**
   * Persist current `entries` to `stateFile`. Atomic-ish: write to
   * `.tmp` then rename. Called after every promote/recover that
   * mutates the entries map.
   */
  private async saveState(): Promise<void> {
    if (this.stateFile === null) return;
    const body: PersistedState = {
      version: '0.1.0',
      entries: Object.fromEntries(this.entries),
    };
    const json = JSON.stringify(body, null, 2);
    await fs.mkdir(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, this.stateFile);
  }

  register<TParsed, TIssue = ValidationIssue>(
    tracker: LKGTracker<TParsed, TIssue>,
  ): void {
    const normalized = this.normalizePath(tracker.path);
    if (this.trackers.has(normalized)) {
      throw new LKGError(
        'LKG_TRACKER_PATH_COLLISION',
        `tracker already registered for path: ${normalized}`,
        normalized,
      );
    }
    this.trackers.set(normalized, tracker as unknown as LKGTracker<unknown, ValidationIssue>);
  }

  async observe(path: string, opts?: LKGObserveOptions): Promise<LKGObservation> {
    // Load persisted entries once before the first observation so
    // post-restart `recover` can find the LKG fingerprint that was
    // promoted in a prior process. No-op on fresh deployments / when
    // stateFile is null (test mode).
    await this.loadStateOnce();
    const normalized = this.normalizePath(path);
    const tracker = this.trackers.get(normalized);
    if (tracker === undefined) {
      throw new LKGError(
        'LKG_TRACKER_PATH_INVALID',
        `no tracker registered for path: ${normalized}`,
        normalized,
      );
    }

    // Workspace-relative URI for audit-event correlation. Synthesized
    // once per observe; passed into outcome shapes via `withOcPath`.
    const ocPath = trackerOcPathString(tracker);

    // Abort-check helper — checks the signal at every I/O boundary.
    // Returns the abort outcome (audit-recorded) when cancelled.
    const checkAbort = async (): Promise<LKGObservation | null> => {
      if (opts?.signal?.aborted !== true) return null;
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: 'aborted: observe cancelled via signal',
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    };

    const aborted0 = await checkAbort();
    if (aborted0 !== null) return aborted0;

    let raw: Buffer;
    let stat;
    try {
      raw = await fs.readFile(normalized);
      stat = await fs.stat(normalized);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: `read failed: ${reason}`,
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    }

    // Sentinel guard (mirrors @openclaw/oc-path's emit-time
    // guard, applied at the LKG observe boundary).
    if (containsSentinel(raw)) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: 'sentinel-detected: refusing to LKG-track redacted-view bytes',
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    }

    const observedAt = this.nowIso();
    const current = makeFingerprint({ raw, stat, observedAt });

    let parsed;
    try {
      parsed = tracker.parse(raw.toString('utf-8'));
    } catch (err) {
      // Scrub the err.message: parse failures on secret-bearing
      // bytes can leak the secret through the diagnostic. Same
      // posture as oc-paths-lint's error-message scrubber.
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: `parse threw: ${scrubErrorMessage(err)}`,
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    }

    let result;
    try {
      result = tracker.validate(parsed);
    } catch (err) {
      // Validator failures on secret-bearing parsed values can leak
      // secrets through err.message; scrub before audit-recording.
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: `validate threw: ${scrubErrorMessage(err)}`,
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    }

    const aborted1 = await checkAbort();
    if (aborted1 !== null) return aborted1;

    if (result.valid) {
      return await this.promote(normalized, current, raw, ocPath);
    }

    return await this.recover(normalized, current, raw, result.issues, tracker, parsed, opts ?? {}, ocPath);
  }

  async readLastKnownGood(path: string, opts?: LKGObserveOptions): Promise<Uint8Array> {
    if (opts?.signal?.aborted === true) {
      throw new LKGError(
        'LKG_ABORTED',
        `readLastKnownGood aborted via signal: ${path}`,
        path,
      );
    }
    const normalized = this.normalizePath(path);
    const lkgPath = lkgPathFor(normalized);
    try {
      return await fs.readFile(lkgPath);
    } catch (err) {
      throw new LKGError(
        'LKG_STORE_UNAVAILABLE',
        `no LKG available for ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
        normalized,
      );
    }
  }

  getEntry(path: string): LKGEntry | null {
    return this.entries.get(this.normalizePath(path)) ?? null;
  }

  async listPaths(): Promise<readonly string[]> {
    await this.loadStateOnce();
    return [...this.entries.keys()];
  }

  // ---------- Labeled pins (upgrade-recovery) -----------------------------

  async promoteAll(opts?: PromoteAllOptions): Promise<PromoteAllResult> {
    await this.loadStateOnce();

    if (opts?.label !== undefined) {
      if (!isValidLabelName(opts.label)) {
        throw new LKGError(
          'LKG_LABEL_INVALID_NAME',
          `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${opts.label}"`,
        );
      }
      // Reject duplicates BEFORE any I/O — labels are immutable.
      for (const [path, entry] of this.entries) {
        if (entry.labels?.[opts.label] !== undefined) {
          throw new LKGError(
            'LKG_LABEL_DUPLICATE',
            `label "${opts.label}" already pinned on ${path}; labels are immutable, delete the existing pin first`,
            path,
          );
        }
      }
    }

    // Phase 1: observe every tracker, accumulate outcomes. Don't write
    // labeled pins yet — we only commit if every tracker validated.
    const outcomes: PromoteAllTrackerOutcome[] = [];
    const successfulPaths: { path: string; raw: Buffer; fingerprint: LKGFingerprint }[] = [];

    for (const [path, _tracker] of this.trackers) {
      try {
        const obs = await this.observe(path);
        if (obs.outcome === 'promoted' || obs.outcome === 'valid') {
          const raw = await fs.readFile(path);
          outcomes.push({ path, outcome: 'promoted', fingerprint: obs.fingerprint });
          successfulPaths.push({ path, raw, fingerprint: obs.fingerprint });
        } else if (obs.outcome === 'failed') {
          outcomes.push({ path, outcome: 'failed', reason: obs.reason });
        } else {
          // 'recovered' or 'skipped' — neither counts as "currently valid"
          // for label-pin purposes.
          const reason =
            obs.outcome === 'recovered'
              ? `recovered (was invalid; bytes restored from prior LKG)`
              : `skipped: ${obs.reason}`;
          outcomes.push({ path, outcome: 'invalid', reason });
        }
      } catch (err) {
        outcomes.push({
          path,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allValid = outcomes.every((o) => o.outcome === 'promoted');

    // Phase 2: if a label was requested, refuse to label unless all valid.
    if (opts?.label !== undefined) {
      if (!allValid) {
        throw new LKGError(
          'LKG_PROMOTE_TRACKER_INVALID',
          `cannot pin label "${opts.label}" — ${outcomes.filter((o) => o.outcome !== 'promoted').length} tracker(s) failed validate`,
        );
      }
      for (const { path, raw, fingerprint } of successfulPaths) {
        const labelPath = labeledPinPathFor(path, opts.label);
        const tmp = `${labelPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
        await fs.writeFile(tmp, raw);
        await fs.rename(tmp, labelPath);
        const entry = this.entries.get(path) ?? {};
        const nextLabels = { ...(entry.labels ?? {}), [opts.label]: fingerprint };
        this.entries.set(path, { ...entry, labels: nextLabels });
      }
      await this.saveState();
    }

    return {
      trackers: outcomes,
      ...(opts?.label !== undefined && allValid ? { label: opts.label } : {}),
      allValid,
    };
  }

  async listLabels(): Promise<readonly LabelEntry[]> {
    await this.loadStateOnce();
    const out: LabelEntry[] = [];
    for (const [path, entry] of this.entries) {
      if (entry.labels === undefined) continue;
      for (const [label, fingerprint] of Object.entries(entry.labels)) {
        out.push({ label, path, fingerprint });
      }
    }
    return out;
  }

  async rollbackToLabel(label: string, _opts?: LKGObserveOptions): Promise<RollbackResult> {
    await this.loadStateOnce();
    if (!isValidLabelName(label)) {
      throw new LKGError(
        'LKG_LABEL_INVALID_NAME',
        `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${label}"`,
      );
    }

    // Collect every (path, fingerprint) pinned under this label.
    const pinned: { path: string; fingerprint: LKGFingerprint }[] = [];
    for (const [path, entry] of this.entries) {
      const fp = entry.labels?.[label];
      if (fp !== undefined) pinned.push({ path, fingerprint: fp });
    }
    if (pinned.length === 0) {
      throw new LKGError(
        'LKG_LABEL_NOT_FOUND',
        `no tracker has a pin under label "${label}"`,
      );
    }

    // Phase 1: VERIFY every companion exists and matches recorded hash.
    // No active-path writes happen until this whole loop succeeds —
    // a half-baked rollback is worse than a no-op rollback.
    const verified: { path: string; fingerprint: LKGFingerprint; bytes: Buffer }[] = [];
    for (const { path, fingerprint } of pinned) {
      const labelPath = labeledPinPathFor(path, label);
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(labelPath);
      } catch (err) {
        throw new LKGError(
          'LKG_ROLLBACK_VERIFY_FAILED',
          `companion missing for label "${label}" at ${labelPath}: ${err instanceof Error ? err.message : String(err)}`,
          path,
        );
      }
      const observedHash = hashRaw(bytes);
      if (observedHash !== fingerprint.hash) {
        throw new LKGError(
          'LKG_ROLLBACK_VERIFY_FAILED',
          `companion hash mismatch for label "${label}" at ${labelPath}: expected ${fingerprint.hash}, got ${observedHash}`,
          path,
        );
      }
      verified.push({ path, fingerprint, bytes });
    }

    // Phase 2: COMMIT — atomic-ish swap each active path. We use
    // tmp+rename per file; the SET is not crash-atomic across files,
    // but each individual write is durable on rename.
    const restored: { path: string; fingerprint: LKGFingerprint }[] = [];
    for (const { path, fingerprint, bytes } of verified) {
      const tmp = `${path}.rollback-${process.pid}-${Date.now().toString(36)}`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, path);
      restored.push({ path, fingerprint });
    }

    return { label, restored };
  }

  async deleteLabel(label: string): Promise<DeleteLabelResult> {
    await this.loadStateOnce();
    if (!isValidLabelName(label)) {
      throw new LKGError(
        'LKG_LABEL_INVALID_NAME',
        `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${label}"`,
      );
    }

    // Walk entries, find pinned trackers, capture their companion paths.
    const targets: { path: string; companionPath: string }[] = [];
    for (const [path, entry] of this.entries) {
      if (entry.labels?.[label] !== undefined) {
        targets.push({ path, companionPath: labeledPinPathFor(path, label) });
      }
    }
    if (targets.length === 0) {
      throw new LKGError(
        'LKG_LABEL_NOT_FOUND',
        `no tracker has a pin under label "${label}"`,
      );
    }

    // Best-effort delete each companion; report whether it actually
    // existed. Idempotent: a partial-prior-state is recoverable.
    const removed: { path: string; companionPath: string; fileExisted: boolean }[] = [];
    for (const t of targets) {
      let fileExisted = true;
      try {
        await fs.unlink(t.companionPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          fileExisted = false;
        } else {
          throw err;
        }
      }
      removed.push({ ...t, fileExisted });
    }

    // Strip the label from every entry's metadata + persist. When the
    // entry has no other labels left, drop the `labels` key entirely
    // (rather than leaving it as an empty object) — keeps the state
    // file tidy.
    for (const t of targets) {
      const entry = this.entries.get(t.path);
      if (entry?.labels === undefined) continue;
      const { [label]: _dropped, ...remainingLabels } = entry.labels;
      void _dropped;
      const { labels: _existing, ...withoutLabels } = entry;
      void _existing;
      const next: LKGEntry =
        Object.keys(remainingLabels).length === 0
          ? withoutLabels
          : { ...withoutLabels, labels: remainingLabels };
      this.entries.set(t.path, next);
    }
    await this.saveState();

    return { label, removed };
  }

  // ---------- internal -----------------------------------------------------

  private normalizePath(p: string): string {
    if (!isAbsolute(p)) {
      throw new LKGError('LKG_TRACKER_PATH_INVALID', `tracker path must be absolute: ${p}`, p);
    }
    const normalized = normalize(p);
    if (this.forbidOutside) {
      const rel = relative(this.root, normalized);
      if (rel.startsWith('..') || (sep === '\\' && rel.startsWith(`..\\`))) {
        throw new LKGError(
          'LKG_TRACKER_PATH_INVALID',
          `tracker path outside store root (${this.root}): ${normalized}`,
          normalized,
        );
      }
    }
    return normalized;
  }

  private async promote(
    path: string,
    current: LKGFingerprint,
    raw: Buffer,
    ocPath: string | undefined,
  ): Promise<LKGObservation> {
    const entry = this.entries.get(path);
    const lastPromotedHash = entry?.lastPromotedGood?.hash;
    if (lastPromotedHash === current.hash) {
      // No change — pure observe outcome.
      const obs: LKGObservation = withOcPath({ outcome: 'valid', fingerprint: current }, ocPath);
      await this.audit(path, obs);
      return obs;
    }

    // Atomic-ish promote: write to `.lkg.tmp`, fsync, rename.
    const lkgPath = lkgPathFor(path);
    const tmpPath = `${lkgPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await fs.mkdir(dirname(lkgPath), { recursive: true });
    await fs.writeFile(tmpPath, raw);
    await fs.rename(tmpPath, lkgPath);

    this.entries.set(path, {
      ...entry,
      lastKnownGood: current,
      lastPromotedGood: current,
    });
    // Persist the entries map so a subsequent process knows this
    // path's last-promoted-good without re-promoting from scratch.
    await this.saveState();

    const obs: LKGObservation = withOcPath({ outcome: 'promoted', fingerprint: current }, ocPath);
    await this.audit(path, obs);
    return obs;
  }

  private async recover(
    path: string,
    current: LKGFingerprint,
    badRaw: Buffer,
    issues: readonly ValidationIssue[],
    tracker: LKGTracker<unknown, ValidationIssue>,
    parsed: unknown,
    opts: LKGObserveOptions,
    ocPath: string | undefined,
  ): Promise<LKGObservation> {
    // shouldRecover now receives the tracker's parsed AST so it can
    // run kind-specific or oc-paths queries inside the heuristic.
    if (tracker.shouldRecover && tracker.shouldRecover({ valid: false, issues, parsed }) === false) {
      const obs: LKGObservation = withOcPath({
        outcome: 'skipped',
        reason: 'plugin-local-invalidity',
        issues,
      }, ocPath);
      await this.audit(path, obs);
      return obs;
    }

    const entry = this.entries.get(path);
    const lkg = entry?.lastPromotedGood;
    if (!lkg) {
      const obs: LKGObservation = withOcPath({
        outcome: 'skipped',
        reason: 'no-lkg-available',
        issues,
      }, ocPath);
      await this.audit(path, obs);
      return obs;
    }

    // Verify LKG companion still matches recorded hash; refuse to
    // restore from a tampered companion.
    const lkgPath = lkgPathFor(path);
    let lkgRaw: Buffer;
    try {
      lkgRaw = await fs.readFile(lkgPath);
    } catch (err) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: `read .lkg failed: ${err instanceof Error ? err.message : String(err)}`,
        issues,
      }, ocPath);
      await this.audit(path, obs);
      return obs;
    }
    const companionHash = hashRaw(lkgRaw);
    if (companionHash !== lkg.hash) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: 'lkg-companion-tampered: hash mismatch',
        issues,
      }, ocPath);
      await this.audit(path, obs);
      return obs;
    }

    // Defense-in-depth: even if the .lkg hash matches, refuse to
    // restore bytes carrying the redaction sentinel. Catches a
    // pathological case where a hash-stable .lkg companion was
    // poisoned at promote time before this guard existed.
    if (containsSentinel(lkgRaw)) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: 'lkg-companion-poisoned: contains redaction sentinel',
        issues,
      }, ocPath);
      await this.audit(path, obs);
      return obs;
    }

    // Preserve bad bytes; restore from .lkg.
    const observedAt = this.nowIso();
    const clobberedPath = clobberedPathFor(path, observedAt);
    await fs.writeFile(clobberedPath, badRaw);
    const clobberedFileHash = hashRaw(badRaw);

    const tmpPath = `${path}.restoring-${process.pid}-${Date.now().toString(36)}`;
    await fs.writeFile(tmpPath, lkgRaw);
    await fs.rename(tmpPath, path);

    const obs: LKGObservation = withOcPath({
      outcome: 'recovered',
      reason: issues[0]?.message ?? 'validation failed',
      clobberedPath,
      clobberedFileHash,
      restoredFrom: lkg,
      replacedFingerprint: current,
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.correlationEventId !== undefined
        ? { correlationEventId: opts.correlationEventId }
        : {}),
    }, ocPath);
    await this.audit(path, obs);
    await this.noticeSink.enqueue({
      path,
      clobberedPath,
      restoredFromHash: lkg.hash,
      replacedFingerprint: current,
      reason: obs.reason,
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.correlationEventId !== undefined
        ? { correlationEventId: opts.correlationEventId }
        : {}),
      observedAt,
    });

    return obs;
  }

  private async audit(path: string, obs: LKGObservation): Promise<void> {
    const observedAt = this.nowIso();
    const base = {
      event: 'lkg.observe' as const,
      path,
      outcome: obs.outcome,
      observedAt,
      // Workspace-relative URI for cross-substrate audit correlation.
      // Absent if the tracker didn't declare an ocPath.
      ...(obs.ocPath !== undefined ? { ocPath: obs.ocPath } : {}),
    };
    if (obs.outcome === 'recovered') {
      await this.auditSink.append({
        ...base,
        clobberedPath: obs.clobberedPath,
        clobberedFileHash: obs.clobberedFileHash,
        replacedFingerprintHash: obs.replacedFingerprint?.hash ?? null,
        reason: obs.reason,
        actor: obs.actor ?? null,
        correlationEventId: obs.correlationEventId ?? null,
      });
      return;
    }
    if (obs.outcome === 'valid' || obs.outcome === 'promoted') {
      await this.auditSink.append({ ...base, fingerprintHash: obs.fingerprint.hash });
      return;
    }
    await this.auditSink.append({ ...base, reason: obs.reason });
  }
}

/**
 * Substring scan for the redaction sentinel. Bytes-or-string input;
 * we use the same literal as the substrate's `REDACTED_SENTINEL` so
 * no copy-paste drift is possible.
 */
function containsSentinel(buf: Buffer | string): boolean {
  if (typeof buf === 'string') return buf.includes(REDACTED_SENTINEL);
  return buf.includes(REDACTED_SENTINEL);
}

/**
 * Scrub a thrown error's message before placing it in an audit
 * record. Mirrors the oc-paths-lint error-message scrubber:
 *
 *   - Refuse to echo the redaction sentinel — replace wholesale.
 *   - Strip ASCII control chars (preserve \t and printable bytes).
 *   - Cap length at 256 bytes to bound leak surface.
 *
 * A validator that crashed on a secret-bearing parsed value could
 * otherwise leak the secret through the audit envelope. Audit
 * records persist to disk + flow into observability pipelines, so
 * the leak surface is wide if unguarded.
 */
const ERR_MESSAGE_MAX_LEN = 256;
function scrubErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes(REDACTED_SENTINEL)) {
    return '[scrubbed: validator/parser message contained redaction sentinel]';
  }
  const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B-\\x1F\\x7F]', 'g');
  const stripped = raw.replace(CONTROL_CHARS, '');
  if (stripped.length <= ERR_MESSAGE_MAX_LEN) return stripped;
  return stripped.slice(0, ERR_MESSAGE_MAX_LEN - 3) + '...';
}

/**
 * Synthesize the workspace-relative `oc://` URI string for a tracker.
 * Returns `undefined` if the tracker didn't declare an `ocPath` —
 * audit events fall back to filesystem path only.
 */
function trackerOcPathString(
  tracker: LKGTracker<unknown, ValidationIssue>,
): string | undefined {
  if (tracker.ocPath === undefined) return undefined;
  return formatOcPath(tracker.ocPath);
}

/**
 * Attach `ocPath` to an observation outcome only if defined. Avoids
 * `ocPath: undefined` appearing in audit envelopes (which downstream
 * JSON serializers handle differently than absent keys).
 */
function withOcPath<T extends LKGObservation>(obs: T, ocPath: string | undefined): T {
  if (ocPath === undefined) return obs;
  return { ...obs, ocPath };
}
