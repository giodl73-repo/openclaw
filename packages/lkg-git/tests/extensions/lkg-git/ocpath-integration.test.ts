/**
 * OcPath integration symmetry with FsLKGStore (L-OcPathIntegration).
 * When a tracker declares an `ocPath`, the git store synthesizes the
 * `oc://...` URI on every observation outcome and into the audit
 * envelope. Backward-compatible: trackers without `ocPath` produce
 * `ocPath`-less observations and audit events.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '@openclaw/lkg';
import { parseOcPath } from '@openclaw/oc-path';
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
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-oc-'));
  gitInit(repoRoot);
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new GitLKGStore({
    repoRoot,
    authorship: { name: 'lkg-test', email: 'lkg@test.local' },
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  return { store, audit, notices, repoRoot };
}

describe('GitLKGStore — OcPath integration (L-OcPathIntegration)', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('GS-OC-01 observation carries ocPath when tracker declares it', async () => {
    const filePath = join(ctx.repoRoot, 'AGENTS.md');
    writeFileSync(filePath, '## Tools\n- gh\n', 'utf-8');
    ctx.store.register({
      path: filePath,
      ocPath: parseOcPath('oc://AGENTS.md'),
      parse: () => ({ valid: true }),
      validate: () => ({ valid: true, issues: [] }),
    });
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.ocPath).toBe('oc://AGENTS.md');
    }
  });

  it('GS-OC-02 observation omits ocPath when tracker does not declare it', async () => {
    const filePath = join(ctx.repoRoot, 'plain.md');
    writeFileSync(filePath, '## H\n', 'utf-8');
    ctx.store.register({
      path: filePath,
      parse: () => ({ valid: true }),
      validate: () => ({ valid: true, issues: [] }),
    });
    const obs = await ctx.store.observe(filePath);
    if (obs.outcome === 'promoted') {
      expect(obs.ocPath).toBeUndefined();
    }
  });

  it('GS-OC-03 audit event includes ocPath in the envelope', async () => {
    const filePath = join(ctx.repoRoot, 'gateway.jsonc');
    writeFileSync(filePath, '{ "version": 1 }\n', 'utf-8');
    ctx.store.register({
      path: filePath,
      ocPath: parseOcPath('oc://gateway.jsonc'),
      parse: () => ({ version: 1 }),
      validate: () => ({ valid: true, issues: [] }),
    });
    await ctx.store.observe(filePath);
    const events = ctx.audit.list();
    expect(events.length).toBeGreaterThan(0);
    const ev = events[events.length - 1]!;
    expect(ev.ocPath).toBe('oc://gateway.jsonc');
  });

  it('GS-OC-04 ocPath flows through recovery outcome too', async () => {
    const filePath = join(ctx.repoRoot, 'session.jsonl');
    const goodBytes = '{"event":"start"}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register({
      path: filePath,
      ocPath: parseOcPath('oc://session.jsonl'),
      parse: (raw) => ({
        last: raw.split('\n').filter((l) => l).slice(-1)[0] ?? '',
      }),
      validate: (parsed) =>
        parsed.last.includes('"event":"end"')
          ? { valid: true, issues: [] }
          : { valid: false, issues: [{ path: '$last', message: 'no terminal' }] },
    });
    await ctx.store.observe(filePath);
    writeFileSync(filePath, '{"event":"start"}\n', 'utf-8');
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('recovered');
    if (obs.outcome === 'recovered') {
      expect(obs.ocPath).toBe('oc://session.jsonl');
    }
  });

  it('GS-OC-05 shouldRecover receives parsed AST for richer queries (item 5)', async () => {
    const filePath = join(ctx.repoRoot, 'AGENTS.md');
    writeFileSync(filePath, '## H\n', 'utf-8');
    let observedParsed: unknown = undefined;
    ctx.store.register({
      path: filePath,
      parse: (raw) => ({ headings: (raw.match(/^## /gm) ?? []).length }),
      validate: () => ({ valid: false, issues: [{ path: '', message: 'forced' }] }),
      shouldRecover: (snapshot) => {
        observedParsed = snapshot.parsed;
        return false;
      },
    });
    await ctx.store.observe(filePath);
    expect(observedParsed).toEqual({ headings: 1 });
  });
});
