/**
 * Sentinel-guard symmetry with FsLKGStore (L-A2/B4).
 *
 * The git-backed store must refuse to commit bytes containing the
 * `__OPENCLAW_REDACTED__` sentinel as known-good — pinning a redacted-
 * view file in HEAD would be a permanent corruption. Defense-in-depth:
 * even if HEAD already contains poisoned bytes (writer-side bug),
 * recovery refuses to restore them.
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

interface JsonContent {
  readonly version: number;
}

const jsonTracker = (path: string): LKGTracker<JsonContent> => ({
  path,
  parse: (raw) => JSON.parse(raw) as JsonContent,
  validate: (parsed) =>
    parsed.version === 1
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ path: 'version', message: 'bad version' }] },
});

function gitInit(repoRoot: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoRoot });
  execFileSync('git', ['config', 'core.eol', 'lf'], { cwd: repoRoot });
}

function safeLog(repoRoot: string): string {
  // `git log` exits non-zero when no commits exist. Treat that as "".
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-sg-'));
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

describe('GitLKGStore — sentinel guard (L-A2/B4)', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('GS-SG-01 observe refuses to commit bytes containing the redaction sentinel', async () => {
    writeFileSync(
      ctx.filePath,
      JSON.stringify({ version: 1, token: '__OPENCLAW_REDACTED__' }) + '\n',
      'utf-8',
    );
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('sentinel-detected');
    }

    // Verify nothing was committed.
    expect(safeLog(ctx.repoRoot)).toBe('');
  });

  it('GS-SG-02 substring-form sentinel triggers refusal (not just exact-match)', async () => {
    writeFileSync(
      ctx.filePath,
      JSON.stringify({ version: 1, msg: 'pre__OPENCLAW_REDACTED__post' }) + '\n',
      'utf-8',
    );
    ctx.store.register(jsonTracker(ctx.filePath));
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
  });

  it('GS-SG-03 recover refuses to restore from sentinel-poisoned HEAD bytes', async () => {
    // Bypass the observe-side guard: directly commit a poisoned blob to
    // HEAD via raw git, simulating a writer-side bug. Defense-in-depth:
    // recover-side guard fires anyway when HEAD bytes contain the
    // sentinel.
    const poisoned =
      JSON.stringify({ version: 1, secret: '__OPENCLAW_REDACTED__' }) + '\n';
    writeFileSync(ctx.filePath, poisoned, 'utf-8');
    execFileSync('git', ['add', '--', 'config.json'], { cwd: ctx.repoRoot });
    execFileSync(
      'git',
      ['commit', '-m', 'poisoned commit (simulated writer bug)'],
      { cwd: ctx.repoRoot },
    );

    // Now register tracker AFTER the poisoned HEAD exists, then write
    // invalid bytes to trigger recovery.
    ctx.store.register(jsonTracker(ctx.filePath));
    writeFileSync(ctx.filePath, JSON.stringify({ version: 99 }) + '\n', 'utf-8');
    const obs = await ctx.store.observe(ctx.filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') {
      expect(obs.reason).toContain('lkg-companion-poisoned');
    }
  });
});
