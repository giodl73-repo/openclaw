/**
 * GitLKGStore lifecycle tests against a real git repo (per-test
 * fixture). Exercises the full promote (commit) → recover (checkout
 * HEAD) cycle.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
  type LKGTracker,
} from '@openclaw/lkg';
import { GitLKGStore } from '../../../src/extensions/lkg-git/store.js';

interface JsonContent {
  readonly version: number;
}

const jsonTracker = (path: string): LKGTracker<JsonContent> => ({
  path,
  parse: (raw) => JSON.parse(raw) as JsonContent,
  validate: (parsed) => {
    if (parsed.version !== 1) {
      return {
        valid: false,
        issues: [
          { path: 'version', message: 'expected version 1', code: 'BAD_VERSION' },
        ],
      };
    }
    return { valid: true, issues: [] };
  },
});

function writeJson(path: string, content: unknown): void {
  writeFileSync(path, JSON.stringify(content) + '\n', 'utf-8');
}

function gitInit(repoRoot: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
}

function makeContext(): {
  store: GitLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  repoRoot: string;
  filePath: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-test-'));
  gitInit(repoRoot);
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new GitLKGStore({
    repoRoot,
    authorship: { name: 'lkg-test', email: 'lkg@test.local' },
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  const filePath = join(repoRoot, 'config.json');
  return { store, audit, notices, repoRoot, filePath };
}

describe('GitLKGStore — lifecycle', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('GS-01 first-time observe of valid bytes → outcome promoted (creates a commit)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('promoted');

    // HEAD now contains the file.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: ctx.repoRoot, encoding: 'utf-8' });
    expect(log).toContain('lkg: promote config.json');
  });

  it('GS-02 fingerprint hash is the git blob sha (content-addressable)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      // Verify the hash matches what git hash-object would produce.
      const sha = execFileSync('git', ['hash-object', 'config.json'], {
        cwd: ctx.repoRoot,
        encoding: 'utf-8',
      }).trim();
      expect(obs.fingerprint.hash).toBe(sha);
    }
  });

  it('GS-03 fingerprint has NO fsStat (git-backed impl)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.fingerprint.fsStat).toBeUndefined();
    }
  });

  it('GS-04 re-observe unchanged → outcome valid (no second commit)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('valid');

    const commitCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: ctx.repoRoot,
      encoding: 'utf-8',
    }).trim();
    expect(commitCount).toBe('1');
  });

  it('GS-05 invalid bytes WITH prior LKG → outcome recovered (git checkout HEAD)', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);

    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('recovered');

    if (obs.outcome === 'recovered') {
      expect(obs.clobberedPath).toMatch(/\.clobbered\./);
      expect(obs.clobberedFileHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.replacedFingerprint?.hash).toMatch(/^[0-9a-f]{40}$/); // git blob sha = 40 hex
    }

    // Active path now matches HEAD.
    const restored = JSON.parse(readFileSync(ctx.filePath, 'utf-8'));
    expect(restored.version).toBe(1);
  });

  it('GS-06 recovery preserves bad bytes at .clobbered.<ts>', async () => {
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

  it('GS-07 recovery enqueues a recovery notice with forensic fields', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);

    writeJson(ctx.filePath, { version: 99 });
    await ctx.store.observe(ctx.filePath, {
      actor: { kind: 'agent-session', id: 'session-abc' },
      correlationEventId: 'turn-42',
    });

    expect(ctx.notices.size()).toBe(1);
    const drained = ctx.notices.drain();
    expect(drained[0]?.actor?.id).toBe('session-abc');
    expect(drained[0]?.correlationEventId).toBe('turn-42');
    expect(drained[0]?.replacedFingerprint?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('GS-08 invalid bytes WITHOUT prior commit → outcome skipped / no-lkg-available', async () => {
    writeJson(ctx.filePath, { version: 99 });
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('skipped');
    if (obs.outcome === 'skipped') {
      expect(obs.reason).toBe('no-lkg-available');
    }
  });

  it('GS-09 readLastKnownGood returns the HEAD blob bytes', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);

    const bytes = await ctx.store.readLastKnownGood(ctx.filePath);
    const text = Buffer.from(bytes).toString('utf-8');
    expect(JSON.parse(text).version).toBe(1);
  });

  it('GS-10 audit sink records each observation', async () => {
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

  it('GS-11 register rejects duplicate tracker paths', () => {
    ctx.store.register(jsonTracker(ctx.filePath));
    expect(() => ctx.store.register(jsonTracker(ctx.filePath))).toThrow(
      /LKG_TRACKER_PATH_COLLISION|already registered/,
    );
  });

  it('GS-12 register rejects paths outside repo root', () => {
    expect(() => ctx.store.register(jsonTracker('/etc/passwd'))).toThrow(
      /LKG_TRACKER_PATH_INVALID|outside repo root/,
    );
  });

  it('GS-13 tracker.shouldRecover === false → outcome skipped / plugin-local-invalidity', async () => {
    writeJson(ctx.filePath, { version: 1 });
    const tracker: LKGTracker<JsonContent> = {
      ...jsonTracker(ctx.filePath),
      shouldRecover: () => false,
    };
    ctx.store.register(tracker);
    await ctx.store.observe(ctx.filePath); // promoted

    writeJson(ctx.filePath, { version: 99 });
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('skipped');
    if (obs.outcome === 'skipped') {
      expect(obs.reason).toBe('plugin-local-invalidity');
    }
  });

  it('GS-14 same content committed by two trackers produces same blob sha (content-addressable)', async () => {
    // Two tracker paths in the same repo, same content → same blob sha.
    const fileA = join(ctx.repoRoot, 'a.json');
    const fileB = join(ctx.repoRoot, 'b.json');
    writeJson(fileA, { version: 1 });
    writeJson(fileB, { version: 1 });
    ctx.store.register(jsonTracker(fileA));
    ctx.store.register(jsonTracker(fileB));
    const obsA = await ctx.store.observe(fileA);
    const obsB = await ctx.store.observe(fileB);
    expect(obsA.outcome).toBe('promoted');
    expect(obsB.outcome).toBe('promoted');
    if (obsA.outcome === 'promoted' && obsB.outcome === 'promoted') {
      expect(obsA.fingerprint.hash).toBe(obsB.fingerprint.hash);
    }
  });

  it('GS-15 getEntry returns cachedEntry post-promote', async () => {
    writeJson(ctx.filePath, { version: 1 });
    ctx.store.register(jsonTracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath);
    const entry = ctx.store.getEntry(ctx.filePath);
    expect(entry?.lastPromotedGood?.hash).toMatch(/^[0-9a-f]{40}$/);
  });
});
