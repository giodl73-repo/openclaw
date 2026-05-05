/**
 * Test harness for tracker authors.
 *
 * Helpers to exercise an `LKGTracker` against a `FsLKGStore` without
 * setting up the full LKG store + sinks scaffolding. Plugin packs
 * use these in their own test suites so they don't have to reinvent
 * fixture mechanics.
 *
 *   import { runTracker, assertPromotes, assertRecovers, assertSkipsForPluginLocal }
 *     from '@openclaw/plugin-sdk/lkg/test-harness';
 *
 *   const ctx = makeTestStore();
 *   ctx.write({ valid: true });
 *   ctx.store.register(myTracker(ctx.path));
 *   await assertPromotes(ctx);
 *
 *   ctx.write({ valid: false });
 *   await assertRecovers(ctx);
 *
 * Keeps tracker-author boilerplate to one-liners.
 *
 * @module @openclaw/plugin-sdk/lkg/test-harness
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../extensions/lkg-fs/index.js';
import type { LKGObservation, LKGObserveOptions } from '../plugin-sdk/lkg/types.js';

/**
 * The test context returned by `makeTestStore`. Carries the store
 * plus sinks (so callers can inspect audit / recovery records) plus
 * helpers to write the tracked file.
 */
export interface LKGTestContext {
  readonly store: FsLKGStore;
  readonly audit: InMemoryAuditSink;
  readonly notices: InMemoryRecoveryNoticeSink;
  readonly workspaceDir: string;
  readonly path: string;
  /** Convenience: write the tracked file. Accepts string or object (JSON-stringifies object). */
  write(content: string | unknown): void;
  /** Convenience: observe the tracked file. */
  observe(opts?: LKGObserveOptions): Promise<LKGObservation>;
}

export interface MakeTestStoreOptions {
  /** Filename inside the workspace (default: `tracked.json`). */
  readonly filename?: string;
  /** Override the "now" timestamp generator (default: `() => new Date().toISOString()`). */
  readonly nowIso?: () => string;
}

/**
 * Make a fresh `FsLKGStore` against an isolated tmpdir workspace.
 * The returned context carries everything needed for a tracker
 * test: store, sinks, the file path, and convenience helpers.
 */
export function makeTestStore(opts: MakeTestStoreOptions = {}): LKGTestContext {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-harness-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
    ...(opts.nowIso !== undefined ? { nowIso: opts.nowIso } : {}),
  });
  const filename = opts.filename ?? 'tracked.json';
  const path = join(workspaceDir, filename);
  return {
    store,
    audit,
    notices,
    workspaceDir,
    path,
    write(content) {
      const bytes =
        typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
      writeFileSync(path, bytes, 'utf-8');
    },
    async observe(observeOpts) {
      return await store.observe(path, observeOpts);
    },
  };
}

/**
 * Run a single observe and return the outcome. Convenience wrapper
 * for tests that don't need the full context.
 */
export async function runTracker(
  ctx: LKGTestContext,
  opts?: LKGObserveOptions,
): Promise<LKGObservation> {
  return ctx.observe(opts);
}

/**
 * Assert the most recent observation produced `outcome: 'promoted'`.
 * Throws with diagnostic detail on any other outcome.
 */
export async function assertPromotes(
  ctx: LKGTestContext,
  opts?: LKGObserveOptions,
): Promise<void> {
  const obs = await ctx.observe(opts);
  if (obs.outcome !== 'promoted') {
    throw new Error(
      `expected promote, got ${obs.outcome}: ${describeOutcome(obs)}`,
    );
  }
}

/**
 * Assert the most recent observation produced `outcome: 'recovered'`.
 * Throws otherwise. Useful for testing the recovery path against an
 * intentionally-corrupted file with a previously-promoted LKG.
 */
export async function assertRecovers(
  ctx: LKGTestContext,
  opts?: LKGObserveOptions,
): Promise<void> {
  const obs = await ctx.observe(opts);
  if (obs.outcome !== 'recovered') {
    throw new Error(
      `expected recover, got ${obs.outcome}: ${describeOutcome(obs)}`,
    );
  }
}

/**
 * Assert the most recent observation skipped recovery for plugin-
 * local invalidity (the `shouldRecover` heuristic returned false).
 */
export async function assertSkipsForPluginLocal(
  ctx: LKGTestContext,
  opts?: LKGObserveOptions,
): Promise<void> {
  const obs = await ctx.observe(opts);
  if (
    obs.outcome !== 'skipped' ||
    (obs.outcome === 'skipped' && obs.reason !== 'plugin-local-invalidity')
  ) {
    throw new Error(
      `expected skip-for-plugin-local, got ${obs.outcome}: ${describeOutcome(obs)}`,
    );
  }
}

/**
 * Assert the most recent observation skipped because no LKG had
 * been promoted yet (the first invalid observe with no fallback).
 */
export async function assertSkipsForNoLkg(
  ctx: LKGTestContext,
  opts?: LKGObserveOptions,
): Promise<void> {
  const obs = await ctx.observe(opts);
  if (
    obs.outcome !== 'skipped' ||
    (obs.outcome === 'skipped' && obs.reason !== 'no-lkg-available')
  ) {
    throw new Error(
      `expected skip-for-no-lkg, got ${obs.outcome}: ${describeOutcome(obs)}`,
    );
  }
}

/**
 * Assert the most recent observation produced a `'failed'` outcome
 * whose `reason` matches the optional regex / substring. Useful for
 * sentinel-guard / abort-signal / hostile-input tests.
 */
export async function assertFails(
  ctx: LKGTestContext,
  reasonMatch?: RegExp | string,
  opts?: LKGObserveOptions,
): Promise<void> {
  const obs = await ctx.observe(opts);
  if (obs.outcome !== 'failed') {
    throw new Error(
      `expected fail, got ${obs.outcome}: ${describeOutcome(obs)}`,
    );
  }
  if (reasonMatch !== undefined) {
    const matches =
      reasonMatch instanceof RegExp
        ? reasonMatch.test(obs.reason)
        : obs.reason.includes(reasonMatch);
    if (!matches) {
      throw new Error(
        `fail reason "${obs.reason}" does not match ${reasonMatch}`,
      );
    }
  }
}

function describeOutcome(obs: LKGObservation): string {
  if (obs.outcome === 'promoted' || obs.outcome === 'valid') {
    return `fingerprint=${obs.fingerprint.hash.slice(0, 12)}`;
  }
  if (obs.outcome === 'recovered') {
    return `recovered from ${obs.restoredFrom.hash.slice(0, 12)}, reason: ${obs.reason}`;
  }
  if (obs.outcome === 'skipped') {
    return `skipped: ${obs.reason}, ${obs.issues.length} issues`;
  }
  return `failed: ${obs.reason}, ${obs.issues.length} issues`;
}
