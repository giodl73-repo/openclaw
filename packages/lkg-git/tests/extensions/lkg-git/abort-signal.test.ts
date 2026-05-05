/**
 * AbortSignal threading symmetry with FsLKGStore (L-B2). Aborts are
 * checked before the I/O boundaries (read, parse, validate, commit/
 * checkout) so callers can cancel a long-running observe.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
  type LKGTracker,
} from '@openclaw/lkg';
import { GitLKGStore } from '../../../src/extensions/lkg-git/store.js';

interface Cfg {
  readonly version: number;
}

const tracker = (path: string): LKGTracker<Cfg> => ({
  path,
  parse: (raw) => JSON.parse(raw) as Cfg,
  validate: (p) =>
    p.version === 1
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ path: 'version', message: 'bad' }] },
});

function gitInit(repoRoot: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoRoot });
  execFileSync('git', ['config', 'core.eol', 'lf'], { cwd: repoRoot });
}

function safeLog(repoRoot: string): string {
  try {
    return execFileSync('git', ['log', '--oneline'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function makeContext(): {
  store: GitLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  repoRoot: string;
  filePath: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-ab-'));
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

describe('GitLKGStore — AbortSignal threading (L-B2)', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('GS-AB-01 already-aborted observe returns failed-aborted before reading', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
    ctx.store.register(tracker(ctx.filePath));
    const ac = new AbortController();
    ac.abort();
    const obs = await ctx.store.observe(ctx.filePath, { signal: ac.signal });
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('aborted');
    }
    // No commit was created.
    expect(safeLog(ctx.repoRoot)).toBe('');
  });

  it('GS-AB-02 readLastKnownGood with pre-aborted signal throws LKG_ABORTED', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
    ctx.store.register(tracker(ctx.filePath));
    await ctx.store.observe(ctx.filePath); // promote first
    const ac = new AbortController();
    ac.abort();
    await expect(
      ctx.store.readLastKnownGood(ctx.filePath, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'LKG_ABORTED' });
  });

  it('GS-AB-03 unaborted signal observe runs to completion', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
    ctx.store.register(tracker(ctx.filePath));
    const ac = new AbortController();
    const obs = await ctx.store.observe(ctx.filePath, { signal: ac.signal });
    expect(obs.outcome).toBe('promoted');
  });
});
