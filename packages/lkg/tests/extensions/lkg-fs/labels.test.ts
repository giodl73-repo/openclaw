/**
 * Labeled-pin tests for FsLKGStore — operator-driven snapshot &
 * rollback flow. Maps to upstream issue #14526 (safer self-update).
 *
 * Naming: `LBL-NN` — orthogonal to the lifecycle suite's `S-NN`.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../../../src/extensions/lkg-fs/index.js';
import { LKGError, type LKGTracker } from '../../../src/plugin-sdk/lkg/types.js';

interface JsonContent {
  readonly version: number;
  readonly value?: string;
}

const jsonTracker = (path: string): LKGTracker<JsonContent> => ({
  path,
  parse: (raw) => JSON.parse(raw) as JsonContent,
  validate: (parsed) =>
    parsed.version === 1
      ? { valid: true, issues: [] }
      : {
          valid: false,
          issues: [{ path: 'version', message: 'expected version 1', code: 'BAD_VERSION' }],
        },
});

function writeJson(path: string, content: unknown): void {
  writeFileSync(path, JSON.stringify(content) + '\n', 'utf-8');
}

interface Ctx {
  store: FsLKGStore;
  workspaceDir: string;
  fileA: string;
  fileB: string;
  fileC: string;
}

function makeCtx(): Ctx {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-fs-labels-'));
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: new InMemoryAuditSink(),
    recoveryNoticeSink: new InMemoryRecoveryNoticeSink(),
  });
  const fileA = join(workspaceDir, 'a.json');
  const fileB = join(workspaceDir, 'b.json');
  const fileC = join(workspaceDir, 'c.json');
  return { store, workspaceDir, fileA, fileB, fileC };
}

function registerThree(ctx: Ctx): void {
  ctx.store.register(jsonTracker(ctx.fileA));
  ctx.store.register(jsonTracker(ctx.fileB));
  ctx.store.register(jsonTracker(ctx.fileC));
}

describe('FsLKGStore — promoteAll without label', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('LBL-01 all valid → every tracker reports promoted', async () => {
    writeJson(ctx.fileA, { version: 1, value: 'a' });
    writeJson(ctx.fileB, { version: 1, value: 'b' });
    writeJson(ctx.fileC, { version: 1, value: 'c' });
    registerThree(ctx);
    const result = await ctx.store.promoteAll();
    expect(result.allValid).toBe(true);
    expect(result.label).toBeUndefined();
    expect(result.trackers).toHaveLength(3);
    expect(result.trackers.every((t) => t.outcome === 'promoted')).toBe(true);
  });

  it('LBL-02 one invalid → allValid=false, others still promoted', async () => {
    writeJson(ctx.fileA, { version: 1 });
    writeJson(ctx.fileB, { version: 99 }); // invalid
    writeJson(ctx.fileC, { version: 1 });
    registerThree(ctx);
    const result = await ctx.store.promoteAll();
    expect(result.allValid).toBe(false);
    const byOutcome = result.trackers.map((t) => t.outcome);
    expect(byOutcome).toContain('invalid');
    expect(byOutcome.filter((o) => o === 'promoted').length).toBe(2);
  });
});

describe('FsLKGStore — promoteAll with label', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
    writeJson(ctx.fileA, { version: 1, value: 'a' });
    writeJson(ctx.fileB, { version: 1, value: 'b' });
    writeJson(ctx.fileC, { version: 1, value: 'c' });
    registerThree(ctx);
  });

  it('LBL-10 all valid + label → label pinned, companion files written', async () => {
    const result = await ctx.store.promoteAll({ label: 'pre-upgrade-1' });
    expect(result.allValid).toBe(true);
    expect(result.label).toBe('pre-upgrade-1');

    expect(existsSync(`${ctx.fileA}.lkg.label.pre-upgrade-1`)).toBe(true);
    expect(existsSync(`${ctx.fileB}.lkg.label.pre-upgrade-1`)).toBe(true);
    expect(existsSync(`${ctx.fileC}.lkg.label.pre-upgrade-1`)).toBe(true);

    const labels = await ctx.store.listLabels();
    expect(labels).toHaveLength(3);
    expect(labels.every((l) => l.label === 'pre-upgrade-1')).toBe(true);
  });

  it('LBL-11 one invalid + label → throws LKG_PROMOTE_TRACKER_INVALID, no companion written', async () => {
    writeJson(ctx.fileB, { version: 99 });
    await expect(ctx.store.promoteAll({ label: 'doomed' })).rejects.toMatchObject({
      code: 'LKG_PROMOTE_TRACKER_INVALID',
    });
    expect(existsSync(`${ctx.fileA}.lkg.label.doomed`)).toBe(false);
    expect(existsSync(`${ctx.fileB}.lkg.label.doomed`)).toBe(false);
  });

  it('LBL-12 promoting same label twice → throws LKG_LABEL_DUPLICATE', async () => {
    await ctx.store.promoteAll({ label: 'frozen' });
    await expect(ctx.store.promoteAll({ label: 'frozen' })).rejects.toMatchObject({
      code: 'LKG_LABEL_DUPLICATE',
    });
  });

  it('LBL-13 invalid label name → throws LKG_LABEL_INVALID_NAME (no I/O)', async () => {
    await expect(ctx.store.promoteAll({ label: 'has/slash' })).rejects.toMatchObject({
      code: 'LKG_LABEL_INVALID_NAME',
    });
    await expect(ctx.store.promoteAll({ label: '' })).rejects.toMatchObject({
      code: 'LKG_LABEL_INVALID_NAME',
    });
    await expect(ctx.store.promoteAll({ label: 'a'.repeat(65) })).rejects.toMatchObject({
      code: 'LKG_LABEL_INVALID_NAME',
    });
  });

  it('LBL-14 multiple labels coexist on the same tracker', async () => {
    await ctx.store.promoteAll({ label: 'first' });
    await ctx.store.promoteAll({ label: 'second' });
    const labels = await ctx.store.listLabels();
    const names = new Set(labels.map((l) => l.label));
    expect(names).toEqual(new Set(['first', 'second']));
    expect(labels).toHaveLength(6); // 2 labels × 3 trackers
  });
});

describe('FsLKGStore — rollbackToLabel', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
    writeJson(ctx.fileA, { version: 1, value: 'original-a' });
    writeJson(ctx.fileB, { version: 1, value: 'original-b' });
    writeJson(ctx.fileC, { version: 1, value: 'original-c' });
    registerThree(ctx);
  });

  it('LBL-20 rollback restores every tracker to its labeled bytes', async () => {
    await ctx.store.promoteAll({ label: 'baseline' });

    // Mutate the active files post-label.
    writeJson(ctx.fileA, { version: 1, value: 'mutated-a' });
    writeJson(ctx.fileB, { version: 1, value: 'mutated-b' });
    writeJson(ctx.fileC, { version: 1, value: 'mutated-c' });

    const result = await ctx.store.rollbackToLabel('baseline');
    expect(result.label).toBe('baseline');
    expect(result.restored).toHaveLength(3);

    expect(JSON.parse(readFileSync(ctx.fileA, 'utf-8')).value).toBe('original-a');
    expect(JSON.parse(readFileSync(ctx.fileB, 'utf-8')).value).toBe('original-b');
    expect(JSON.parse(readFileSync(ctx.fileC, 'utf-8')).value).toBe('original-c');
  });

  it('LBL-21 rollback to unknown label → throws LKG_LABEL_NOT_FOUND, no writes', async () => {
    const aBefore = readFileSync(ctx.fileA, 'utf-8');
    await expect(ctx.store.rollbackToLabel('does-not-exist')).rejects.toMatchObject({
      code: 'LKG_LABEL_NOT_FOUND',
    });
    expect(readFileSync(ctx.fileA, 'utf-8')).toBe(aBefore);
  });

  it('LBL-22 rollback verify-fails when companion is tampered → throws, no writes', async () => {
    await ctx.store.promoteAll({ label: 'safe' });
    // Corrupt one companion's bytes (hash will no longer match recorded fingerprint).
    writeFileSync(`${ctx.fileB}.lkg.label.safe`, 'tampered\n', 'utf-8');

    const aBeforeRollback = readFileSync(ctx.fileA, 'utf-8');
    writeJson(ctx.fileA, { version: 1, value: 'mutated-a-after-tamper' });

    await expect(ctx.store.rollbackToLabel('safe')).rejects.toMatchObject({
      code: 'LKG_ROLLBACK_VERIFY_FAILED',
    });
    // Verify phase-1 caught the tamper BEFORE writing — fileA's
    // mutation should still be on disk (not rolled back), proving the
    // all-or-nothing guarantee.
    expect(readFileSync(ctx.fileA, 'utf-8')).not.toBe(aBeforeRollback);
    expect(JSON.parse(readFileSync(ctx.fileA, 'utf-8')).value).toBe('mutated-a-after-tamper');
  });

  it('LBL-23 rollback verify-fails when companion is missing → throws, no writes', async () => {
    await ctx.store.promoteAll({ label: 'fragile' });
    // Delete one companion.
    const fs = await import('node:fs/promises');
    await fs.unlink(`${ctx.fileC}.lkg.label.fragile`);

    await expect(ctx.store.rollbackToLabel('fragile')).rejects.toMatchObject({
      code: 'LKG_ROLLBACK_VERIFY_FAILED',
    });
  });

  it('LBL-24 rollback bytes match the original size + hash recorded at label time', async () => {
    const sizeBefore = statSync(ctx.fileA).size;
    await ctx.store.promoteAll({ label: 'sized' });

    // Mutate to a different size.
    writeJson(ctx.fileA, {
      version: 1,
      value: 'a much longer value to force a different file size from the original',
    });
    expect(statSync(ctx.fileA).size).not.toBe(sizeBefore);

    await ctx.store.rollbackToLabel('sized');
    expect(statSync(ctx.fileA).size).toBe(sizeBefore);
  });

  it('LBL-25 rollback survives a process restart (state persisted)', async () => {
    await ctx.store.promoteAll({ label: 'durable' });
    writeJson(ctx.fileA, { version: 1, value: 'mutated-after-restart' });

    // Simulate restart: discard old store, build a fresh one against the
    // same workspaceDir. The state file must persist `labels` so the
    // new store can find the pin.
    const fresh = new FsLKGStore({
      root: ctx.workspaceDir,
      auditSink: new InMemoryAuditSink(),
      recoveryNoticeSink: new InMemoryRecoveryNoticeSink(),
    });
    fresh.register(jsonTracker(ctx.fileA));
    fresh.register(jsonTracker(ctx.fileB));
    fresh.register(jsonTracker(ctx.fileC));

    const result = await fresh.rollbackToLabel('durable');
    expect(result.restored).toHaveLength(3);
    expect(JSON.parse(readFileSync(ctx.fileA, 'utf-8')).value).toBe('original-a');
  });
});

describe('FsLKGStore — deleteLabel', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
    writeJson(ctx.fileA, { version: 1 });
    writeJson(ctx.fileB, { version: 1 });
    writeJson(ctx.fileC, { version: 1 });
    registerThree(ctx);
  });

  it('LBL-40 deletes companion files + state metadata', async () => {
    await ctx.store.promoteAll({ label: 'transient' });
    expect(existsSync(`${ctx.fileA}.lkg.label.transient`)).toBe(true);

    const result = await ctx.store.deleteLabel('transient');
    expect(result.label).toBe('transient');
    expect(result.removed).toHaveLength(3);
    expect(result.removed.every((r) => r.fileExisted)).toBe(true);

    expect(existsSync(`${ctx.fileA}.lkg.label.transient`)).toBe(false);
    expect(existsSync(`${ctx.fileB}.lkg.label.transient`)).toBe(false);
    expect(existsSync(`${ctx.fileC}.lkg.label.transient`)).toBe(false);

    const labels = await ctx.store.listLabels();
    expect(labels.filter((l) => l.label === 'transient')).toHaveLength(0);
  });

  it('LBL-41 unblocks re-pinning the same label name', async () => {
    await ctx.store.promoteAll({ label: 'reusable' });
    await ctx.store.deleteLabel('reusable');
    // Re-pin the same name — would have thrown LKG_LABEL_DUPLICATE before delete.
    const result = await ctx.store.promoteAll({ label: 'reusable' });
    expect(result.label).toBe('reusable');
    expect(result.allValid).toBe(true);
  });

  it('LBL-42 unknown label → throws LKG_LABEL_NOT_FOUND', async () => {
    await expect(ctx.store.deleteLabel('never-existed')).rejects.toMatchObject({
      code: 'LKG_LABEL_NOT_FOUND',
    });
  });

  it('LBL-43 invalid label name → throws LKG_LABEL_INVALID_NAME', async () => {
    await expect(ctx.store.deleteLabel('has space')).rejects.toMatchObject({
      code: 'LKG_LABEL_INVALID_NAME',
    });
  });

  it('LBL-44 idempotent against partial state — companion already gone', async () => {
    await ctx.store.promoteAll({ label: 'partial' });
    // Operator manually deletes one companion outside the store's awareness.
    const fs = await import('node:fs/promises');
    await fs.unlink(`${ctx.fileB}.lkg.label.partial`);

    const result = await ctx.store.deleteLabel('partial');
    expect(result.removed).toHaveLength(3);
    const fileExistedById = new Map(result.removed.map((r) => [r.path, r.fileExisted]));
    expect(fileExistedById.get(ctx.fileA)).toBe(true);
    expect(fileExistedById.get(ctx.fileB)).toBe(false); // already gone
    expect(fileExistedById.get(ctx.fileC)).toBe(true);
    // State metadata still cleaned for all three.
    const labels = await ctx.store.listLabels();
    expect(labels.filter((l) => l.label === 'partial')).toHaveLength(0);
  });

  it('LBL-45 deleting one label leaves other labels intact', async () => {
    await ctx.store.promoteAll({ label: 'keep' });
    await ctx.store.promoteAll({ label: 'drop' });
    await ctx.store.deleteLabel('drop');
    const labels = await ctx.store.listLabels();
    expect(labels.every((l) => l.label === 'keep')).toBe(true);
    expect(labels).toHaveLength(3);
  });
});

describe('FsLKGStore — listLabels', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
    writeJson(ctx.fileA, { version: 1 });
    writeJson(ctx.fileB, { version: 1 });
    writeJson(ctx.fileC, { version: 1 });
    registerThree(ctx);
  });

  it('LBL-30 empty when no labels created', async () => {
    await ctx.store.promoteAll(); // unlabeled promote
    const labels = await ctx.store.listLabels();
    expect(labels).toHaveLength(0);
  });

  it('LBL-31 enumerates one row per (label, tracker) pair', async () => {
    await ctx.store.promoteAll({ label: 'L1' });
    await ctx.store.promoteAll({ label: 'L2' });
    const labels = await ctx.store.listLabels();
    expect(labels).toHaveLength(6);
    const grouped = new Map<string, number>();
    for (const l of labels) grouped.set(l.label, (grouped.get(l.label) ?? 0) + 1);
    expect(grouped.get('L1')).toBe(3);
    expect(grouped.get('L2')).toBe(3);
  });
});
