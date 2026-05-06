/**
 * `GitLKGStore` — git-backed `LKGStore` impl.
 *
 *   promote = `git commit` (the registered tracker's path becomes
 *             part of HEAD)
 *   recover = `git checkout HEAD -- <path>` (working tree restored
 *             from HEAD)
 *   lastPromotedGood = HEAD's blob sha for the tracker path
 *
 * Same contract as the FS-backed store. Two reasons to choose git:
 *
 *   1. **Content-addressable**: identical bytes → identical blob sha.
 *      Concurrent writes of the same blob are idempotent (no race).
 *      Different blobs → different paths in `.git/objects/` (no
 *      contention either). Only ref updates contend.
 *
 *   2. **Three-way merge for free**: under any deployment exposing a
 *      shared git working tree (FUSE-mounted shared FS like
 *      rclone+OneDrive, NFS, SMB; or distinct local clones with a git
 *      remote), two agents editing the same file no longer silently
 *      lose one edit. Closes #40245.
 *
 * @module @openclaw/lkg-git/store
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type {
  DeleteLabelResult,
  LKGEntry,
  LKGFingerprint,
  LKGObservation,
  LKGObserveOptions,
  LKGStore,
  LKGTracker,
  LabelEntry,
  PromoteAllOptions,
  PromoteAllResult,
  PromoteAllTrackerOutcome,
  RollbackResult,
  ValidationIssue,
} from '@openclaw/lkg';
import { LKGError } from '@openclaw/lkg';
import {
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
  type LKGAuditSink,
  type LKGRecoveryNoticeSink,
} from '@openclaw/lkg';
import { REDACTED_SENTINEL, formatOcPath } from '@openclaw/oc-path';

import { git, gitBinary } from './git-cmd.js';

/**
 * Operator-facing label-name validator. Mirrors the FS-backed impl;
 * names map 1:1 to git tag names under the `lkg/` namespace, so
 * keeping the rules identical means an FS-staged label can later
 * migrate to a git-backed store without renaming.
 */
const LABEL_NAME_RE = /^[A-Za-z0-9._-]+$/;
function isValidLabelName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 64) return false;
  return LABEL_NAME_RE.test(name);
}

/** Tag-prefix that namespaces LKG-managed tags away from operator tags. */
const TAG_PREFIX = 'lkg/';

export interface GitAuthorship {
  readonly name: string;
  readonly email: string;
}

export interface GitLKGStoreOptions {
  /** Absolute path to a git work tree (must already be `git init`-ed). */
  readonly repoRoot: string;
  /** Author identity for LKG-produced commits. */
  readonly authorship: GitAuthorship;
  readonly auditSink?: LKGAuditSink;
  readonly recoveryNoticeSink?: LKGRecoveryNoticeSink;
  /** Override "now" for deterministic tests. */
  readonly nowIso?: () => string;
  /** Reject tracker paths outside `repoRoot` (default: true). */
  readonly forbidPathsOutsideRoot?: boolean;
}

interface RegisteredTracker {
  readonly tracker: LKGTracker<unknown, ValidationIssue>;
  /** Path relative to repoRoot (what git operates on). */
  readonly relPath: string;
  cachedEntry: LKGEntry;
}

function hashRaw(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function clobberedRelPath(relPath: string, observedAt: string): string {
  const safe = observedAt.replace(/[:.]/g, '-');
  return `${relPath}.clobbered.${safe}`;
}

export class GitLKGStore implements LKGStore {
  private readonly trackers = new Map<string, RegisteredTracker>();
  private readonly repoRoot: string;
  private readonly authorship: GitAuthorship;
  private readonly auditSink: LKGAuditSink;
  private readonly noticeSink: LKGRecoveryNoticeSink;
  private readonly nowIso: () => string;
  private readonly forbidOutside: boolean;

  constructor(opts: GitLKGStoreOptions) {
    this.repoRoot = resolve(opts.repoRoot);
    this.authorship = opts.authorship;
    this.auditSink = opts.auditSink ?? new InMemoryAuditSink();
    this.noticeSink = opts.recoveryNoticeSink ?? new InMemoryRecoveryNoticeSink();
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.forbidOutside = opts.forbidPathsOutsideRoot ?? true;
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
    const relPath = relative(this.repoRoot, normalized).replace(/\\/g, '/');
    this.trackers.set(normalized, {
      tracker: tracker as unknown as LKGTracker<unknown, ValidationIssue>,
      relPath,
      cachedEntry: {},
    });
  }

  async observe(path: string, opts?: LKGObserveOptions): Promise<LKGObservation> {
    const normalized = this.normalizePath(path);
    const reg = this.trackers.get(normalized);
    if (reg === undefined) {
      throw new LKGError(
        'LKG_TRACKER_PATH_INVALID',
        `no tracker registered for path: ${normalized}`,
        normalized,
      );
    }

    // Workspace-relative URI for audit-event correlation. Synthesized
    // once per observe (L-OcPathIntegration items 1, 2, 3).
    const ocPath = trackerOcPathString(reg.tracker);

    // Abort-check helper (L-B2). Records an audit-recorded
    // failed-aborted outcome at every I/O boundary.
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
    try {
      raw = await fs.readFile(normalized);
    } catch (err) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: `read failed: ${scrubErrorMessage(err)}`,
        issues: [],
      }, ocPath);
      await this.audit(normalized, obs);
      return obs;
    }

    // Sentinel guard (L-A2/B4). Symmetric with the FS-backed store —
    // refuse to git-commit bytes containing the redaction sentinel
    // as known-good.
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
    const current = await this.fingerprintForActive(reg.relPath, raw, observedAt);

    let parsed;
    try {
      parsed = reg.tracker.parse(raw.toString('utf-8'));
    } catch (err) {
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
      result = reg.tracker.validate(parsed);
    } catch (err) {
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
      return await this.promote(reg, normalized, current, observedAt, ocPath);
    }
    return await this.recover(reg, normalized, current, raw, result.issues, parsed, observedAt, opts ?? {}, ocPath);
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
    const reg = this.trackers.get(normalized);
    if (reg === undefined) {
      throw new LKGError(
        'LKG_STORE_UNAVAILABLE',
        `no tracker registered for path: ${normalized}`,
        normalized,
      );
    }
    // `git show HEAD:<relPath>` — binary-safe.
    const result = await gitBinary(['show', `HEAD:${reg.relPath}`], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (result.exitCode !== 0) {
      throw new LKGError(
        'LKG_STORE_UNAVAILABLE',
        `no LKG available for ${normalized}: ${result.stderr.trim()}`,
        normalized,
      );
    }
    return result.stdout;
  }

  getEntry(path: string): LKGEntry | null {
    const reg = this.trackers.get(this.normalizePath(path));
    if (reg === undefined) return null;
    return reg.cachedEntry;
  }

  async listPaths(): Promise<readonly string[]> {
    const out: string[] = [];
    for (const [path, reg] of this.trackers) {
      // Only paths that have actually been promoted are meaningful
      // — a freshly-registered tracker has an empty cachedEntry.
      if (reg.cachedEntry.lastPromotedGood !== undefined) out.push(path);
    }
    return out;
  }

  // ---------- Labeled pins (upgrade-recovery) -----------------------------
  // Mapping: label `<name>` ⇔ git tag `lkg/<name>` at HEAD. Rollback
  // restores tracked paths from `git checkout lkg/<name> -- <relPath>`.
  // The `lkg/` namespace keeps LKG-managed tags clearly separated from
  // operator-authored tags so `git tag --list 'lkg/*'` enumerates them
  // and operators don't worry about colliding with our reserved set.

  async promoteAll(opts?: PromoteAllOptions): Promise<PromoteAllResult> {
    if (opts?.label !== undefined) {
      if (!isValidLabelName(opts.label)) {
        throw new LKGError(
          'LKG_LABEL_INVALID_NAME',
          `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${opts.label}"`,
        );
      }
      const tagName = `${TAG_PREFIX}${opts.label}`;
      const existing = await git(['tag', '-l', tagName], { cwd: this.repoRoot });
      if (existing.stdout.trim() !== '') {
        throw new LKGError(
          'LKG_LABEL_DUPLICATE',
          `git tag "${tagName}" already exists; labels are immutable, delete the tag first`,
        );
      }
    }

    // Observe every tracker; observe() promotes (git commit) on its own.
    const outcomes: PromoteAllTrackerOutcome[] = [];
    for (const [path, _reg] of this.trackers) {
      try {
        const obs = await this.observe(path);
        if (obs.outcome === 'promoted' || obs.outcome === 'valid') {
          outcomes.push({ path, outcome: 'promoted', fingerprint: obs.fingerprint });
        } else if (obs.outcome === 'failed') {
          outcomes.push({ path, outcome: 'failed', reason: obs.reason });
        } else {
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

    if (opts?.label !== undefined) {
      if (!allValid) {
        throw new LKGError(
          'LKG_PROMOTE_TRACKER_INVALID',
          `cannot tag "${TAG_PREFIX}${opts.label}" — ${outcomes.filter((o) => o.outcome !== 'promoted').length} tracker(s) failed validate`,
        );
      }
      // Tag HEAD which now carries all the per-tracker promote commits.
      const tagName = `${TAG_PREFIX}${opts.label}`;
      await git(['tag', tagName, 'HEAD'], { cwd: this.repoRoot });
    }

    return {
      trackers: outcomes,
      ...(opts?.label !== undefined && allValid ? { label: opts.label } : {}),
      allValid,
    };
  }

  async listLabels(): Promise<readonly LabelEntry[]> {
    const tagsResult = await git(['tag', '-l', `${TAG_PREFIX}*`], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    const tagNames = tagsResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(TAG_PREFIX));

    const out: LabelEntry[] = [];
    const observedAt = this.nowIso();
    for (const tag of tagNames) {
      const label = tag.slice(TAG_PREFIX.length);
      for (const [path, reg] of this.trackers) {
        const fp = await this.fingerprintFromRef(reg.relPath, tag, observedAt);
        if (fp === null) continue; // tag predates this tracker, skip
        out.push({ label, path, fingerprint: fp });
      }
    }
    return out;
  }

  async rollbackToLabel(label: string, _opts?: LKGObserveOptions): Promise<RollbackResult> {
    if (!isValidLabelName(label)) {
      throw new LKGError(
        'LKG_LABEL_INVALID_NAME',
        `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${label}"`,
      );
    }
    const tagName = `${TAG_PREFIX}${label}`;

    // Phase 1: verify tag exists AND every tracker has a blob under it.
    const tagCheck = await git(['tag', '-l', tagName], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (tagCheck.stdout.trim() !== tagName) {
      throw new LKGError(
        'LKG_LABEL_NOT_FOUND',
        `git tag "${tagName}" does not exist`,
      );
    }

    const observedAt = this.nowIso();
    const verified: { path: string; relPath: string; fingerprint: LKGFingerprint }[] = [];
    for (const [path, reg] of this.trackers) {
      const fp = await this.fingerprintFromRef(reg.relPath, tagName, observedAt);
      if (fp === null) {
        throw new LKGError(
          'LKG_ROLLBACK_VERIFY_FAILED',
          `tag "${tagName}" has no blob for tracked path "${reg.relPath}"`,
          path,
        );
      }
      verified.push({ path, relPath: reg.relPath, fingerprint: fp });
    }

    // Phase 2: checkout each tracked file from the tag. Each `git
    // checkout <tag> -- <path>` is atomic; the SET of writes is not
    // crash-atomic across files.
    const restored: { path: string; fingerprint: LKGFingerprint }[] = [];
    for (const v of verified) {
      const checkoutResult = await git(['checkout', tagName, '--', v.relPath], {
        cwd: this.repoRoot,
        tolerateNonZero: true,
      });
      if (checkoutResult.exitCode !== 0) {
        throw new LKGError(
          'LKG_ROLLBACK_VERIFY_FAILED',
          `git checkout failed mid-rollback at ${v.relPath}: ${checkoutResult.stderr.trim()}`,
          v.path,
        );
      }
      restored.push({ path: v.path, fingerprint: v.fingerprint });
    }

    return { label, restored };
  }

  async deleteLabel(label: string): Promise<DeleteLabelResult> {
    if (!isValidLabelName(label)) {
      throw new LKGError(
        'LKG_LABEL_INVALID_NAME',
        `label must match [A-Za-z0-9._-]+ and be 1-64 chars: "${label}"`,
      );
    }
    const tagName = `${TAG_PREFIX}${label}`;
    const tagCheck = await git(['tag', '-l', tagName], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (tagCheck.stdout.trim() !== tagName) {
      throw new LKGError(
        'LKG_LABEL_NOT_FOUND',
        `git tag "${tagName}" does not exist`,
      );
    }

    // Capture which trackers this tag pinned BEFORE deleting the tag,
    // so we can report the same shape as the FS impl.
    const observedAt = this.nowIso();
    const removed: { path: string; companionPath: string; fileExisted: boolean }[] = [];
    for (const [path, reg] of this.trackers) {
      const fp = await this.fingerprintFromRef(reg.relPath, tagName, observedAt);
      if (fp === null) continue;
      // For the git backend, "companionPath" is the conceptual git ref.
      // The blob is content-addressable in `.git/objects/`, eligible for
      // `git gc` once the tag is removed.
      removed.push({ path, companionPath: `git:${tagName}:${reg.relPath}`, fileExisted: true });
    }

    await git(['tag', '-d', tagName], { cwd: this.repoRoot });

    return { label, removed };
  }

  /**
   * Lookup helper: blob sha + size for a relPath at a given git ref
   * (tag, branch, or commit). Returns null if the ref doesn't carry a
   * blob for that path.
   */
  private async fingerprintFromRef(
    relPath: string,
    ref: string,
    observedAt: string,
  ): Promise<LKGFingerprint | null> {
    const result = await git(['ls-tree', '-r', ref, '--', relPath], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (result.exitCode !== 0) return null;
    const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
    if (line === undefined) return null;
    const parts = line.split('\t')[0]?.split(/\s+/);
    const sha = parts?.[2];
    if (sha === undefined) return null;
    const sizeResult = await git(['cat-file', '-s', sha], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    const bytes = parseInt(sizeResult.stdout.trim(), 10);
    return {
      hash: sha,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      observedAt,
    };
  }

  // ---------- internal -----------------------------------------------------

  private normalizePath(p: string): string {
    if (!isAbsolute(p)) {
      throw new LKGError('LKG_TRACKER_PATH_INVALID', `tracker path must be absolute: ${p}`, p);
    }
    const normalized = normalize(p);
    if (this.forbidOutside) {
      const rel = relative(this.repoRoot, normalized);
      if (rel.startsWith('..') || (sep === '\\' && rel.startsWith(`..\\`))) {
        throw new LKGError(
          'LKG_TRACKER_PATH_INVALID',
          `tracker path outside repo root (${this.repoRoot}): ${normalized}`,
          normalized,
        );
      }
    }
    return normalized;
  }

  private async fingerprintForActive(
    relPath: string,
    raw: Buffer,
    observedAt: string,
  ): Promise<LKGFingerprint> {
    // Compute the git blob sha that WOULD result from committing this
    // content. This is the content-addressable hash even before commit.
    const result = await git(['hash-object', '--', relPath], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    const sha = result.exitCode === 0 ? result.stdout.trim() : hashRaw(raw);
    return {
      hash: sha,
      bytes: raw.byteLength,
      observedAt,
      // No fsStat — git-backed impl. Per the contract, non-FS backends
      // omit the fsStat appendix entirely.
    };
  }

  private async fingerprintFromHead(
    relPath: string,
    observedAt: string,
  ): Promise<LKGFingerprint | null> {
    const result = await git(['ls-tree', '-r', 'HEAD', '--', relPath], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (result.exitCode !== 0) return null;
    const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
    if (line === undefined) return null;
    const parts = line.split('\t')[0]?.split(/\s+/);
    const sha = parts?.[2];
    if (sha === undefined) return null;
    const sizeResult = await git(['cat-file', '-s', sha], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    const bytes = parseInt(sizeResult.stdout.trim(), 10);
    return {
      hash: sha,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      observedAt,
    };
  }

  private async promote(
    reg: RegisteredTracker,
    absPath: string,
    current: LKGFingerprint,
    observedAt: string,
    ocPath: string | undefined,
  ): Promise<LKGObservation> {
    const headFp = await this.fingerprintFromHead(reg.relPath, observedAt);
    if (headFp !== null && headFp.hash === current.hash) {
      // Already at HEAD — pure observe, no commit.
      reg.cachedEntry = {
        ...reg.cachedEntry,
        lastKnownGood: current,
        lastPromotedGood: current,
      };
      const obs: LKGObservation = withOcPath({ outcome: 'valid', fingerprint: current }, ocPath);
      await this.audit(absPath, obs);
      return obs;
    }
    // Stage + commit.
    await git(['add', '--', reg.relPath], { cwd: this.repoRoot });
    await git(
      ['commit', '-m', `lkg: promote ${reg.relPath}`, '--', reg.relPath],
      {
        cwd: this.repoRoot,
        config: {
          'user.name': this.authorship.name,
          'user.email': this.authorship.email,
        },
        tolerateNonZero: true,
      },
    );

    reg.cachedEntry = {
      ...reg.cachedEntry,
      lastKnownGood: current,
      lastPromotedGood: current,
    };

    const obs: LKGObservation = withOcPath({ outcome: 'promoted', fingerprint: current }, ocPath);
    await this.audit(absPath, obs);
    return obs;
  }

  private async recover(
    reg: RegisteredTracker,
    absPath: string,
    current: LKGFingerprint,
    badRaw: Buffer,
    issues: readonly ValidationIssue[],
    parsed: unknown,
    observedAt: string,
    opts: LKGObserveOptions,
    ocPath: string | undefined,
  ): Promise<LKGObservation> {
    const tracker = reg.tracker;
    // shouldRecover now receives the tracker's parsed AST (item 5) so
    // it can run kind-specific or oc-paths queries.
    if (tracker.shouldRecover && tracker.shouldRecover({ valid: false, issues, parsed }) === false) {
      const obs: LKGObservation = withOcPath({
        outcome: 'skipped',
        reason: 'plugin-local-invalidity',
        issues,
      }, ocPath);
      await this.audit(absPath, obs);
      return obs;
    }

    const headFp = await this.fingerprintFromHead(reg.relPath, observedAt);
    if (headFp === null) {
      const obs: LKGObservation = withOcPath({
        outcome: 'skipped',
        reason: 'no-lkg-available',
        issues,
      }, ocPath);
      await this.audit(absPath, obs);
      return obs;
    }

    // Defense-in-depth: even when HEAD has the tracker's path, refuse
    // to restore bytes carrying the redaction sentinel. Mirrors the
    // FS-backed store's check (L-A2/B4 defense-in-depth path).
    const headBytesResult = await gitBinary(['show', `HEAD:${reg.relPath}`], {
      cwd: this.repoRoot,
      tolerateNonZero: true,
    });
    if (headBytesResult.exitCode === 0 && containsSentinel(headBytesResult.stdout)) {
      const obs: LKGObservation = withOcPath({
        outcome: 'failed',
        reason: 'lkg-companion-poisoned: HEAD bytes contain redaction sentinel',
        issues,
      }, ocPath);
      await this.audit(absPath, obs);
      return obs;
    }

    // Preserve bad bytes as `.clobbered.<ts>`, then `git checkout HEAD --
    // <relPath>` to restore the working tree.
    const clobberedAbsPath = `${absPath}.clobbered.${observedAt.replace(/[:.]/g, '-')}`;
    await fs.writeFile(clobberedAbsPath, badRaw);
    const clobberedFileHash = hashRaw(badRaw);

    await git(['checkout', 'HEAD', '--', reg.relPath], { cwd: this.repoRoot });

    reg.cachedEntry = { ...reg.cachedEntry, lastKnownGood: headFp, lastPromotedGood: headFp };

    const clobberedRel = clobberedRelPath(reg.relPath, observedAt);
    const obs: LKGObservation = withOcPath({
      outcome: 'recovered',
      reason: issues[0]?.message ?? 'validation failed',
      clobberedPath: clobberedAbsPath,
      clobberedFileHash,
      restoredFrom: headFp,
      replacedFingerprint: current,
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.correlationEventId !== undefined
        ? { correlationEventId: opts.correlationEventId }
        : {}),
    }, ocPath);
    await this.audit(absPath, obs);
    await this.noticeSink.enqueue({
      path: absPath,
      clobberedPath: clobberedAbsPath,
      restoredFromHash: headFp.hash,
      replacedFingerprint: current,
      reason: obs.reason,
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.correlationEventId !== undefined
        ? { correlationEventId: opts.correlationEventId }
        : {}),
      observedAt,
    });
    // Touch local var to satisfy lint about unused values.
    void clobberedRel;

    return obs;
  }

  private async audit(absPath: string, obs: LKGObservation): Promise<void> {
    const observedAt = this.nowIso();
    const base = {
      event: 'lkg.observe' as const,
      path: absPath,
      outcome: obs.outcome,
      observedAt,
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

// ---------- helpers (mirrored from FsLKGStore for parity) -------------------

/**
 * Substring scan for the redaction sentinel — same threat as the
 * substrate's emit-time guard. Bytes-or-string input.
 */
function containsSentinel(buf: Buffer | Uint8Array | string): boolean {
  if (typeof buf === 'string') return buf.includes(REDACTED_SENTINEL);
  // Buffer.includes works on string; Uint8Array doesn't, so funnel both
  // through Buffer.from for uniform treatment.
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.includes(REDACTED_SENTINEL);
}

/**
 * Scrub thrown error messages before audit-recording (L-C10).
 * Refuse sentinel passthrough; strip control chars; cap 256 bytes.
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
 * Synthesize the workspace-relative `oc://` URI for a tracker that
 * declared one. Returns `undefined` for trackers without `ocPath`.
 */
function trackerOcPathString(
  tracker: LKGTracker<unknown, ValidationIssue>,
): string | undefined {
  if (tracker.ocPath === undefined) return undefined;
  return formatOcPath(tracker.ocPath);
}

/**
 * Attach `ocPath` to an observation only if defined; avoids
 * `ocPath: undefined` in audit envelopes.
 */
function withOcPath<T extends LKGObservation>(obs: T, ocPath: string | undefined): T {
  if (ocPath === undefined) return obs;
  return { ...obs, ocPath };
}
