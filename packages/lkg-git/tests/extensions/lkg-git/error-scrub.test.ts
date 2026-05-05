/**
 * `err.message` scrubbing in audit-recorded `failed` outcomes
 * (L-C10). Symmetric with FsLKGStore's scrub: refuse sentinel
 * passthrough, strip control chars, cap at 256 bytes.
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-scrub-'));
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

describe('GitLKGStore — err.message scrub (L-C10)', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('GS-SCR-01 sentinel-bearing thrown message is wholesale scrubbed', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
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

  it('GS-SCR-02 control characters stripped from thrown message', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
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

  it('GS-SCR-03 long message truncated at 256 bytes', async () => {
    writeFileSync(ctx.filePath, JSON.stringify({ version: 1 }) + '\n', 'utf-8');
    const longMsg = 'x'.repeat(500);
    ctx.store.register(trackerWithThrowingValidator(ctx.filePath, longMsg));
    const obs = await ctx.store.observe(ctx.filePath);
    if (obs.outcome === 'failed') {
      expect(obs.reason.length).toBeLessThanOrEqual('validate threw: '.length + 256);
      expect(obs.reason.endsWith('...')).toBe(true);
    }
  });
});
