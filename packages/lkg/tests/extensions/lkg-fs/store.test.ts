/**
 * FsLKGStore lifecycle tests — promote / observe / recover with real
 * filesystem fixtures.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../../../src/extensions/lkg-fs/index.js';
import type { LKGTracker } from '../../../src/plugin-sdk/lkg/types.js';

interface JsonContent {
  readonly version: number;
  readonly entries: Record<string, string>;
}

const jsonTracker = (path: string): LKGTracker<JsonContent> => ({
  path,
  parse: (raw) => JSON.parse(raw) as JsonContent,
  validate: (parsed) => {
    if (parsed.version !== 1) {
      return {
        valid: false,
        issues: [{ path: 'version', message: 'expected version 1', code: 'BAD_VERSION' }],
      };
    }
    return { valid: true, issues: [] };
  },
});

function writeJson(path: string, content: unknown): void {
  writeFileSync(path, JSON.stringify(content) + '\n', 'utf-8');
}

function makeStore(): {
  store: FsLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  workspaceDir: string;
  filePath: string;
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-fs-test-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  const filePath = join(workspaceDir, 'config.json');
  return { store, audit, notices, workspaceDir, filePath };
}

describe('FsLKGStore — lifecycle', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it('S-01 first-time observe of valid bytes → outcome promoted', async () => {
    writeJson(ctx.filePath, { version: 1, entries: { a: '1' } });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.fingerprint.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.fingerprint.fsStat).toBeDefined();
    }
  });

  it('S-02 re-observe unchanged bytes → outcome valid (not promoted twice)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('valid');
  });

  it('S-03 observe valid → .lkg companion file written', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    const lkgPath = ctx.filePath + '.lkg';
    expect(readFileSync(lkgPath, 'utf-8')).toBe(readFileSync(ctx.filePath, 'utf-8'));
  });

  it('S-04 observe invalid bytes WITH a prior LKG → outcome recovered', async () => {
    // Promote a known-good first.
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);

    // Now simulate a bad write.
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('recovered');
    if (obs.outcome === 'recovered') {
      expect(obs.clobberedPath).toMatch(/\.clobbered\./);
      expect(obs.clobberedFileHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.replacedFingerprint?.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Active path now matches LKG content.
    const restored = JSON.parse(readFileSync(ctx.filePath, 'utf-8'));
    expect(restored.version).toBe(1);
  });

  it('S-05 recovery preserves bad bytes at .clobbered.<ts>', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('recovered');
    if (obs.outcome === 'recovered') {
      const clobbered = JSON.parse(readFileSync(obs.clobberedPath, 'utf-8'));
      expect(clobbered.version).toBe(99);
    }
  });

  it('S-06 recovery enqueues a recovery notice', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    writeJson(ctx.filePath, { version: 99 });
    await ctx.store.observe(ctx.filePath);
    expect(ctx.notices.size()).toBe(1);
    const drained = ctx.notices.drain();
    expect(drained[0]?.path).toBe(ctx.filePath);
    expect(drained[0]?.reason).toContain('expected version 1');
  });

  it('S-07 recovery passes actor + correlationEventId from observe options', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath, {
      actor: { kind: 'plugin', id: 'my-plugin' },
      correlationEventId: 'trace-xyz',
    });
    expect(obs.outcome).toBe('recovered');
    if (obs.outcome === 'recovered') {
      expect(obs.actor?.id).toBe('my-plugin');
      expect(obs.correlationEventId).toBe('trace-xyz');
    }
  });

  it('S-08 invalid bytes WITHOUT prior LKG → outcome skipped / no-lkg-available', async () => {
    writeJson(ctx.filePath, { version: 99 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('skipped');
    if (obs.outcome === 'skipped') {
      expect(obs.reason).toBe('no-lkg-available');
    }
  });

  it('S-09 tracker.shouldRecover === false → outcome skipped / plugin-local-invalidity', async () => {
    writeJson(ctx.filePath, { version: 1 });
    const tracker: LKGTracker<JsonContent> = {
      ...jsonTracker(ctx.filePath),
      shouldRecover: () => false,
    };
    ctx.store.register(tracker);
    await ctx.store.observe(ctx.filePath); // promote
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('skipped');
    if (obs.outcome === 'skipped') {
      expect(obs.reason).toBe('plugin-local-invalidity');
    }
  });

  it('S-10 audit sink receives a record per observation', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath); // promoted
    await ctx.store.observe(ctx.filePath); // valid
    writeJson(ctx.filePath, { version: 99 });
    await ctx.store.observe(ctx.filePath); // recovered

    const records = ctx.audit.list();
    expect(records.length).toBe(3);
    expect(records.map((r) => r.outcome)).toEqual(['promoted', 'valid', 'recovered']);
  });

  it('S-11 readLastKnownGood returns the promoted bytes', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    const lkgBytes = await ctx.store.readLastKnownGood(ctx.filePath);
    const text = Buffer.from(lkgBytes).toString('utf-8');
    expect(JSON.parse(text).version).toBe(1);
  });

  it('S-12 getEntry returns null pre-observation; populated post-promote', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    expect(ctx.store.getEntry(ctx.filePath)).toBeNull();
    await ctx.store.observe(ctx.filePath);
    const entry = ctx.store.getEntry(ctx.filePath);
    expect(entry?.lastPromotedGood?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('S-13 register rejects duplicate paths with LKG_TRACKER_PATH_COLLISION', () => {
    ctx.store.register(jsonTracker(ctx.filePath));
    expect(() => ctx.store.register(jsonTracker(ctx.filePath))).toThrow(
      /LKG_TRACKER_PATH_COLLISION|already registered/,
    );
  });

  it('S-14 register rejects paths outside store root', () => {
    expect(() => ctx.store.register(jsonTracker('/etc/passwd'))).toThrow(
      /LKG_TRACKER_PATH_INVALID|outside store root/,
    );
  });

  it('S-15 observe of unregistered path throws LKG_TRACKER_PATH_INVALID', async () => {
    await expect(ctx.store.observe(ctx.filePath)).rejects.toThrow(
      /LKG_TRACKER_PATH_INVALID|no tracker registered/,
    );
  });

  it('S-16 corrupt .lkg companion → outcome failed (refuse to restore)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    // Tamper with the .lkg companion.
    writeFileSync(ctx.filePath + '.lkg', '{"version":99}\n', 'utf-8');
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('lkg-companion-tampered');
    }
  });
});

describe('FsLKGStore — AbortSignal threading (L-B2)', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it('AB-01 already-aborted signal returns failed-aborted before reading', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const ac = new AbortController();
    ac.abort();
    const obs = await ctx.store.observe(ctx.filePath, { signal: ac.signal });
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('aborted');
    }
  });

  it('AB-02 aborted readLastKnownGood throws LKG_ABORTED', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath); // promote first
    const ac = new AbortController();
    ac.abort();
    await expect(
      ctx.store.readLastKnownGood(ctx.filePath, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'LKG_ABORTED' });
  });

  it('AB-03 unaborted signal observe runs to completion', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const ac = new AbortController();
    const obs = await ctx.store.observe(ctx.filePath, { signal: ac.signal });
    expect(obs.outcome).toBe('promoted');
  });
});

describe('FsLKGStore — err.message scrub (L-C10)', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  const trackerWithThrowingValidator = (
    path: string,
    msg: string,
  ): LKGTracker<{ version: number }> => ({
    path,
    parse: (raw) => JSON.parse(raw) as { version: number },
    validate: () => {
      throw new Error(msg);
    },
  });

  it('SCR-01 sentinel-bearing thrown message is wholesale scrubbed', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(
      trackerWithThrowingValidator(
        ctx.filePath,
        'leaked __OPENCLAW_REDACTED__ in error',
      ),
    );
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).not.toContain('__OPENCLAW_REDACTED__');
      expect(obs.reason).toContain('[scrubbed:');
    }
  });

  it('SCR-02 control characters stripped from thrown message', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(
      trackerWithThrowingValidator(
        ctx.filePath,
        'safe\x00\x07text\x1F\x7Fmore',
      ),
    );
    const obs = await ctx.store.observe(ctx.filePath);
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('safetextmore');
    }
  });

  it('SCR-03 long message truncated at 256 bytes', async () => {
    writeJson(ctx.filePath, { version: 1 });
    const longMsg = 'x'.repeat(500);
    ctx.store.register(trackerWithThrowingValidator(ctx.filePath, longMsg));
    const obs = await ctx.store.observe(ctx.filePath);
    if (obs.outcome === 'failed') {
      // 256 cap on the scrubbed substring; full message has the
      // "validate threw: " prefix so total can be slightly longer.
      expect(obs.reason.length).toBeLessThanOrEqual('validate threw: '.length + 256);
      expect(obs.reason.endsWith('...')).toBe(true);
    }
  });
});

describe('FsLKGStore — sentinel guard (L-A2/B4)', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it('SG-01 observe refuses to LKG-track bytes containing the redaction sentinel', async () => {
    // A redacted-view file leaks through to disk via some bug path.
    // LKG must NOT promote it as known-good — that would pin the
    // corruption.
    writeFileSync(
      ctx.filePath,
      JSON.stringify({ version: 1, entries: { token: '__OPENCLAW_REDACTED__' } }) + '\n',
      'utf-8',
    );
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('sentinel-detected');
    }
  });

  it('SG-02 sentinel substring (not just exact-match) triggers refusal', async () => {
    // Hostile caller smuggling `prefix__OPENCLAW_REDACTED__suffix`
    // must not slip past — same posture as the substrate's
    // sentinel guard (oc-paths A2 finding).
    writeFileSync(
      ctx.filePath,
      JSON.stringify({ version: 1, msg: 'pre__OPENCLAW_REDACTED__post' }) + '\n',
      'utf-8',
    );
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
  });

  it('SG-03 recover refuses to restore from a sentinel-poisoned .lkg companion', async () => {
    // Promote a clean LKG, then poison the .lkg companion with the
    // sentinel without touching its sha (impossible in practice, but
    // the defense-in-depth check fires anyway).
    writeJson(ctx.filePath, { version: 1, entries: {} });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath); // first promote

    // Manually poison the .lkg companion AND update the entry's
    // recorded hash to match (simulating a writer-side bug that
    // coordinated bad bytes with stored fingerprint).
    const poisoned =
      JSON.stringify({ version: 1, entries: { x: '__OPENCLAW_REDACTED__' } }) + '\n';
    writeFileSync(ctx.filePath + '.lkg', poisoned, 'utf-8');
    // Force the recorded hash to match the poisoned companion via
    // private-state poke (we don't expose this in production).
    const entry = ctx.store.getEntry(ctx.filePath);
    if (entry?.lastPromotedGood) {
      const { createHash } = await import('node:crypto');
      const newHash = createHash('sha256').update(poisoned).digest('hex');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.store as any).entries.set(ctx.filePath, {
        ...entry,
        lastPromotedGood: { ...entry.lastPromotedGood, hash: newHash },
      });
    }

    // Now write invalid bytes to the active path to trigger recovery.
    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('lkg-companion-poisoned');
    }
  });
});

describe('FsLKGStore — state-file persistence', () => {
  it('SP-01 writes lkg-health.json after a promote', async () => {
    const ctx = makeStore();
    ctx.store.register(jsonTracker(ctx.filePath));
    writeJson(ctx.filePath, { version: 1, entries: { ok: 'yes' } });
    await ctx.store.observe(ctx.filePath);
    const stateFile = join(ctx.workspaceDir, '.openclaw', 'lkg-health.json');
    const body = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(body.version).toBe('0.1.0');
    expect(body.entries).toBeDefined();
    expect(Object.keys(body.entries)).toContain(ctx.filePath);
  });

  it('SP-02 a fresh store loads the prior process\'s entries on first observe', async () => {
    // Process 1: promote a file, save state.
    const ctx = makeStore();
    ctx.store.register(jsonTracker(ctx.filePath));
    writeJson(ctx.filePath, { version: 1, entries: { ok: 'yes' } });
    await ctx.store.observe(ctx.filePath);

    // Process 2: brand-new store instance pointed at the same root.
    // It should load the prior entries and recognize the .lkg companion.
    const audit2 = new InMemoryAuditSink();
    const notices2 = new InMemoryRecoveryNoticeSink();
    const store2 = new FsLKGStore({
      root: ctx.workspaceDir,
      auditSink: audit2,
      recoveryNoticeSink: notices2,
    });
    store2.register(jsonTracker(ctx.filePath));

    // Same content — should be 'valid' (no re-promote), proving the
    // store recognized the prior LKG fingerprint without re-promoting.
    const obs = await store2.observe(ctx.filePath);
    expect(obs.outcome).toBe('valid');
  });

  it('SP-03 stateFile: null disables persistence (no .openclaw/ created)', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-no-state-'));
    const filePath = join(workspaceDir, 'config.json');
    const audit = new InMemoryAuditSink();
    const notices = new InMemoryRecoveryNoticeSink();
    const store = new FsLKGStore({
      root: workspaceDir,
      auditSink: audit,
      recoveryNoticeSink: notices,
      stateFile: null,
    });
    store.register(jsonTracker(filePath));
    writeJson(filePath, { version: 1, entries: { ok: 'yes' } });
    const obs = await store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
    // No state file written.
    const stateFile = join(workspaceDir, '.openclaw', 'lkg-health.json');
    expect(() => readFileSync(stateFile, 'utf-8')).toThrow(/ENOENT/);
  });

  it('SP-04 corrupt state file throws on next observe', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-corrupt-state-'));
    const filePath = join(workspaceDir, 'config.json');
    // Pre-poison the state file before constructing the store.
    const stateFile = join(workspaceDir, '.openclaw', 'lkg-health.json');
    writeFileSync(join(workspaceDir, '.openclaw'), '', 'utf-8');
    // Recreate as a directory (workaround for the above test create).
    require('node:fs').rmSync(join(workspaceDir, '.openclaw'));
    require('node:fs').mkdirSync(join(workspaceDir, '.openclaw'), { recursive: true });
    writeFileSync(stateFile, '{ this is not valid json', 'utf-8');

    const store = new FsLKGStore({ root: workspaceDir });
    store.register(jsonTracker(filePath));
    writeJson(filePath, { version: 1, entries: { ok: 'yes' } });

    await expect(store.observe(filePath)).rejects.toThrow(/state file parse failed/);
  });
});
