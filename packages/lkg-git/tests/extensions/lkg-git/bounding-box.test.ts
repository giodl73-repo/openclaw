/**
 * Bounding-box coverage proof for the git-backed store: same claim as
 * the FS-backed store, namely that LKG protects all four oc-paths file
 * kinds (md / jsonc / jsonl / yaml). Promote → corrupt → recover round
 * trip per kind. The git store's mechanism is byte-level (blob sha)
 * so kind-agnosticism is structural; these tests lock the claim.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
  type LKGTracker,
} from '@openclaw/lkg';
import { GitLKGStore } from '../../../src/extensions/lkg-git/store.js';

interface Ctx {
  store: GitLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  repoRoot: string;
}

function gitInit(repoRoot: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  // Disable Windows autocrlf so byte-level round-trip assertions hold.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoRoot });
  execFileSync('git', ['config', 'core.eol', 'lf'], { cwd: repoRoot });
}

function makeCtx(): Ctx {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lkg-git-bbox-'));
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

describe('GitLKGStore bounding box — md kind', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const mdTracker = (path: string): LKGTracker<{ headings: number }> => ({
    path,
    parse: (raw) => ({ headings: (raw.match(/^## /gm) ?? []).length }),
    validate: (parsed) =>
      parsed.headings > 0
        ? { valid: true, issues: [] }
        : { valid: false, issues: [{ path: '', message: 'no H2 headings' }] },
  });

  it('GBBOX-MD-01 promote → recover round-trip on AGENTS.md', async () => {
    const filePath = join(ctx.repoRoot, 'AGENTS.md');
    const goodBytes = '## Tools\n- gh\n## Boundaries\n- never rm -rf\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(mdTracker(filePath));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    writeFileSync(filePath, 'just a paragraph, no headings\n', 'utf-8');
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('GitLKGStore bounding box — jsonc kind', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const jsoncTracker = (path: string): LKGTracker<{ version: number }> => ({
    path,
    parse: (raw) => {
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(stripped) as { version: number };
    },
    validate: (parsed) =>
      parsed.version === 1
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: [{ path: 'version', message: 'expected version 1' }],
          },
  });

  it('GBBOX-JSONC-01 comment-bearing bytes round-trip through HEAD', async () => {
    const filePath = join(ctx.repoRoot, 'gateway.jsonc');
    const goodBytes = '// keep this comment\n{\n  "version": 1\n}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsoncTracker(filePath));
    await ctx.store.observe(filePath); // promote

    writeFileSync(filePath, '{ "version": 99 }\n', 'utf-8'); // corrupt
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('GitLKGStore bounding box — jsonl kind', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const jsonlTracker = (path: string): LKGTracker<{ terminated: boolean }> => ({
    path,
    parse: (raw) => {
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last === undefined) return { terminated: false };
      try {
        const parsed = JSON.parse(last) as { event?: string };
        return { terminated: parsed.event === 'end' };
      } catch {
        return { terminated: false };
      }
    },
    validate: (parsed) =>
      parsed.terminated
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: [{ path: '$last/event', message: 'session not terminated' }],
          },
  });

  it('GBBOX-JSONL-01 promote → recover on session log', async () => {
    const filePath = join(ctx.repoRoot, 'session.jsonl');
    const goodBytes =
      '{"event":"start"}\n{"event":"step","n":1}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsonlTracker(filePath));
    await ctx.store.observe(filePath);

    writeFileSync(filePath, '{"event":"start"}\n{"event":"step"}\n', 'utf-8');
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('GitLKGStore bounding box — yaml kind (.lobster)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const yamlTracker = (path: string): LKGTracker<{ stepCount: number }> => ({
    path,
    parse: (raw) => ({
      stepCount: (raw.match(/^\s*-\s+id:\s*/gm) ?? []).length,
    }),
    validate: (parsed) =>
      parsed.stepCount > 0
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: [{ path: 'steps', message: 'workflow has no steps' }],
          },
  });

  it('GBBOX-YAML-01 promote → recover on .lobster workflow', async () => {
    const filePath = join(ctx.repoRoot, 'wf.lobster');
    const goodBytes =
      'steps:\n  - id: build\n    command: gh workflow run\n  - id: test\n    command: vitest\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(yamlTracker(filePath));
    await ctx.store.observe(filePath);

    writeFileSync(filePath, 'steps: []\n', 'utf-8');
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });

  it('GBBOX-YAML-02 .yaml extension also covered', async () => {
    const filePath = join(ctx.repoRoot, 'pipeline.yaml');
    const goodBytes = 'steps:\n  - id: only\n    command: echo hi\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(yamlTracker(filePath));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });
});

describe('GitLKGStore bounding box — content-addressable parity', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const trivialTracker = (path: string): LKGTracker<true> => ({
    path,
    parse: () => true,
    validate: () => ({ valid: true, issues: [] }),
  });

  it('GBBOX-DEDUPE-01 same content across kinds → same blob sha', async () => {
    // Identical bytes in two different filenames produce identical
    // git blob shas. This is the "free deduplication" property the
    // git-backed store gets vs. the FS-backed store. A bounding-box
    // claim because it's structural, not kind-specific.
    const a = join(ctx.repoRoot, 'a.md');
    const b = join(ctx.repoRoot, 'b.jsonc');
    const bytes = 'identical\n';
    writeFileSync(a, bytes, 'utf-8');
    writeFileSync(b, bytes, 'utf-8');
    ctx.store.register(trivialTracker(a));
    ctx.store.register(trivialTracker(b));
    const obsA = await ctx.store.observe(a);
    const obsB = await ctx.store.observe(b);
    expect(obsA.outcome).toBe('promoted');
    expect(obsB.outcome).toBe('promoted');
    if (obsA.outcome === 'promoted' && obsB.outcome === 'promoted') {
      expect(obsA.fingerprint.hash).toBe(obsB.fingerprint.hash);
    }
  });
});
