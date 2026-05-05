/**
 * Bounding-box coverage proof: LKG protects all four oc-paths file
 * kinds (md / jsonc / jsonl / yaml/.lobster). The LKG mechanism is
 * byte-level so kind-agnosticism is structural — these tests lock
 * the claim with concrete promote → mutate → recover round-trips,
 * one per kind.
 *
 * **Why this matters**: oc-paths kept growing during design (md →
 * +jsonc → +jsonl → +yaml). The LKG bounding box must match — a
 * consumer using `setOcPath` to mutate a yaml workflow expects LKG
 * to protect those bytes the same way it protects gateway config.
 *
 * **Tracker shape per kind**: each test plugs a kind-specific
 * `parse + validate` pair into the universal `LKGTracker<TParsed>`
 * interface. The store machinery (read → fingerprint → sentinel →
 * parse → validate → promote/recover) doesn't know what kind it's
 * looking at; only the tracker does. This is the design contract
 * the bounding-box proof asserts.
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

interface Ctx {
  store: FsLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  workspaceDir: string;
}

function makeCtx(): Ctx {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-bbox-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  return { store, audit, notices, workspaceDir };
}

describe('LKG bounding box — md kind (workspace markdown)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  // Cheap structural validator: a "valid" SOUL.md has at least one
  // `## ` heading. Real callers use the oc-paths substrate's MdAst.
  const mdTracker = (path: string): LKGTracker<{ headings: number }> => ({
    path,
    parse: (raw) => ({ headings: (raw.match(/^## /gm) ?? []).length }),
    validate: (parsed) =>
      parsed.headings > 0
        ? { valid: true, issues: [] }
        : { valid: false, issues: [{ path: '', message: 'no H2 headings' }] },
  });

  it('BBOX-MD-01 promote → recover round-trip on AGENTS.md', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    const goodBytes = '## Tools\n- gh\n## Boundaries\n- never rm -rf\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(mdTracker(filePath));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    // Corrupt the file (no H2 = invalid). Recovery should restore.
    writeFileSync(filePath, 'just a paragraph, no headings\n', 'utf-8');
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });

  it('BBOX-MD-02 sentinel-bearing markdown is refused at observe', async () => {
    const filePath = join(ctx.workspaceDir, 'SOUL.md');
    writeFileSync(
      filePath,
      '## Identity\nOperator: __OPENCLAW_REDACTED__\n',
      'utf-8',
    );
    ctx.store.register(mdTracker(filePath));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('failed');
    if (obs.outcome === 'failed') expect(obs.reason).toContain('sentinel-detected');
  });
});

describe('LKG bounding box — jsonc kind (gateway config with comments)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const jsoncTracker = (path: string): LKGTracker<{ version: number }> => ({
    path,
    parse: (raw) => {
      // Cheap JSONC parser: strip line comments + trailing-comma
      // forgiveness. Real callers use parseJsonc from the substrate.
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

  it('BBOX-JSONC-01 promote preserves comment bytes through .lkg companion', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    const goodBytes =
      '// gateway config\n{\n  "version": 1,\n  "plugins": {} // empty for now\n}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsoncTracker(filePath));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    // The .lkg companion is byte-identical to the active file.
    expect(readFileSync(filePath + '.lkg', 'utf-8')).toBe(goodBytes);
  });

  it('BBOX-JSONC-02 recovery restores comment-bearing bytes verbatim', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    const goodBytes = '// keep this comment\n{\n  "version": 1,\n}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsoncTracker(filePath));
    await ctx.store.observe(filePath); // promote

    writeFileSync(filePath, '{ "version": 99 }\n', 'utf-8'); // corrupt
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    // Comments come back from the .lkg companion.
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('LKG bounding box — jsonl kind (session logs)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  // A "valid" session log ends with a terminal event line.
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

  it('BBOX-JSONL-01 promote → recover round-trip on session log', async () => {
    const filePath = join(ctx.workspaceDir, 'session.jsonl');
    const goodBytes =
      '{"event":"start"}\n{"event":"step","n":1}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsonlTracker(filePath));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    // Corrupt: drop the terminal event.
    writeFileSync(filePath, '{"event":"start"}\n{"event":"step"}\n', 'utf-8');
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });

  it('BBOX-JSONL-02 sentinel-bearing session log is refused at observe', async () => {
    const filePath = join(ctx.workspaceDir, 'audit.jsonl');
    writeFileSync(
      filePath,
      '{"event":"start"}\n{"event":"action","payload":"__OPENCLAW_REDACTED__"}\n{"event":"end"}\n',
      'utf-8',
    );
    ctx.store.register(jsonlTracker(filePath));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('failed');
  });
});

describe('LKG bounding box — yaml kind (.lobster workflows)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  // A "valid" workflow has a `steps:` block with at least one entry.
  const yamlTracker = (path: string): LKGTracker<{ stepCount: number }> => ({
    path,
    parse: (raw) => {
      const stepCount = (raw.match(/^\s*-\s+id:\s*/gm) ?? []).length;
      return { stepCount };
    },
    validate: (parsed) =>
      parsed.stepCount > 0
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: [{ path: 'steps', message: 'workflow has no steps' }],
          },
  });

  it('BBOX-YAML-01 promote → recover round-trip on .lobster workflow', async () => {
    const filePath = join(ctx.workspaceDir, 'wf.lobster');
    const goodBytes =
      'steps:\n  - id: build\n    command: gh workflow run\n  - id: test\n    command: vitest\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(yamlTracker(filePath));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    writeFileSync(filePath, 'steps: []\n', 'utf-8'); // corrupt
    const recover = await ctx.store.observe(filePath);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });

  it('BBOX-YAML-02 .yaml extension also covered (alias of .lobster)', async () => {
    const filePath = join(ctx.workspaceDir, 'pipeline.yaml');
    const goodBytes = 'steps:\n  - id: only-step\n    command: echo hi\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(yamlTracker(filePath));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });
});

describe('LKG bounding box — workspace-relative ocPath threading (L-OcPathIntegration)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  // The store synthesizes `ocPath: 'oc://...'` on observations and
  // audit events when the tracker declares an `ocPath` field. SIEM /
  // observability pipelines correlate LKG events with oc-lint /
  // oc-doctor diagnostics through this URI vocabulary.

  it('OCPATH-01 observation carries ocPath when tracker declares it', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    writeFileSync(filePath, '## Tools\n- gh\n', 'utf-8');
    const { parseOcPath } = await import('@openclaw/oc-path');
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

  it('OCPATH-02 observation omits ocPath when tracker does not declare it', async () => {
    const filePath = join(ctx.workspaceDir, 'plain.md');
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

  it('OCPATH-03 audit event includes ocPath in the envelope', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    writeFileSync(filePath, '{ "version": 1 }\n', 'utf-8');
    const { parseOcPath } = await import('@openclaw/oc-path');
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

  it('OCPATH-04 ocPath flows through recovery outcome too', async () => {
    const filePath = join(ctx.workspaceDir, 'session.jsonl');
    const goodBytes = '{"event":"start"}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    const { parseOcPath } = await import('@openclaw/oc-path');
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

  it('OCPATH-05 shouldRecover receives parsed AST for richer queries (item 5)', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    writeFileSync(filePath, '## H\n', 'utf-8');
    let observedParsed: unknown = undefined;
    ctx.store.register({
      path: filePath,
      parse: (raw) => ({ headings: (raw.match(/^## /gm) ?? []).length }),
      validate: () => ({ valid: false, issues: [{ path: '', message: 'forced' }] }),
      shouldRecover: (snapshot) => {
        observedParsed = snapshot.parsed;
        return false; // skip; we just want to capture parsed
      },
    });
    await ctx.store.observe(filePath);
    expect(observedParsed).toEqual({ headings: 1 });
  });
});

describe('LKG bounding box — companion-path conventions across kinds', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  // The `.lkg` and `.clobbered.<ts>` suffixes append to the original
  // path — they don't replace the extension. This means
  // `AGENTS.md.lkg`, `gateway.jsonc.lkg`, `session.jsonl.lkg`, and
  // `wf.lobster.lkg` all coexist cleanly.
  const trivialTracker = (path: string): LKGTracker<true> => ({
    path,
    parse: () => true,
    validate: () => ({ valid: true, issues: [] }),
  });

  it('BBOX-PATH-01 .lkg companion path appends, not replaces, original extension', async () => {
    const tests = [
      'AGENTS.md',
      'gateway.jsonc',
      'session.jsonl',
      'wf.lobster',
      'pipeline.yaml',
    ];
    for (const name of tests) {
      const filePath = join(ctx.workspaceDir, name);
      writeFileSync(filePath, 'placeholder bytes', 'utf-8');
      ctx.store.register(trivialTracker(filePath));
      await ctx.store.observe(filePath);
      // The companion is `<name>.lkg`, not `<basename>.lkg` (no
      // extension replacement).
      expect(readFileSync(filePath + '.lkg', 'utf-8')).toBe('placeholder bytes');
    }
  });
});
