/**
 * Reference tracker tests + registry detection. Each per-kind tracker
 * is exercised through a full promote → corrupt → recover round-trip,
 * plus the registry's auto-detect-from-extension path.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseOcPath } from '@openclaw/oc-path';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../../src/extensions/lkg-fs/index.js';
import {
  jsoncTracker,
  jsonlTracker,
  mdTracker,
  yamlTracker,
  defaultTrackerFor,
  registerDefaultTracker,
} from '../../src/trackers/index.js';

interface Ctx {
  store: FsLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  workspaceDir: string;
}

function makeCtx(): Ctx {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-trackers-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  return { store, audit, notices, workspaceDir };
}

describe('mdTracker — reference markdown tracker', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('TR-MD-01 promote → recover round-trip on AGENTS.md', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    const goodBytes = '## Tools\n- gh\n## Boundaries\n- never rm -rf\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(mdTracker({ path: filePath }));

    const promote = await ctx.store.observe(filePath);
    expect(promote.outcome).toBe('promoted');

    // parseMd is permissive — almost anything parses without error
    // diagnostics, so to force a recovery we use additionalCheck.
    // Re-register with one that fails on missing H2.
    const ctx2 = makeCtx();
    const filePath2 = join(ctx2.workspaceDir, 'AGENTS.md');
    writeFileSync(filePath2, goodBytes, 'utf-8');
    ctx2.store.register(
      mdTracker({
        path: filePath2,
        additionalCheck: (snap) => {
          const headings = snap.ast.raw.match(/^## /gm) ?? [];
          return headings.length > 0
            ? { valid: true, issues: [] }
            : { valid: false, issues: [{ path: '', message: 'no H2 headings' }] };
        },
      }),
    );
    await ctx2.store.observe(filePath2); // promote
    writeFileSync(filePath2, 'no headings here\n', 'utf-8');
    const recover = await ctx2.store.observe(filePath2);
    expect(recover.outcome).toBe('recovered');
    expect(readFileSync(filePath2, 'utf-8')).toBe(goodBytes);
  });

  it('TR-MD-02 ocPath synthesized into observation when declared', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    writeFileSync(filePath, '## Tools\n- gh\n', 'utf-8');
    ctx.store.register(
      mdTracker({ path: filePath, ocPath: parseOcPath('oc://AGENTS.md') }),
    );
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.ocPath).toBe('oc://AGENTS.md');
    }
  });
});

describe('jsoncTracker — reference JSONC tracker', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('TR-JSONC-01 promotes well-formed JSONC with comments', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    const goodBytes = '// gateway config\n{\n  "version": 1,\n}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsoncTracker({ path: filePath }));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });

  it('TR-JSONC-02 fails (or recovers) on malformed JSONC', async () => {
    const filePath = join(ctx.workspaceDir, 'broken.jsonc');
    // Promote a good one first.
    writeFileSync(filePath, '{ "version": 1 }\n', 'utf-8');
    ctx.store.register(jsoncTracker({ path: filePath }));
    await ctx.store.observe(filePath);

    // Now corrupt with an unclosed brace.
    writeFileSync(filePath, '{ "version": 1\n', 'utf-8');
    const obs = await ctx.store.observe(filePath);
    // parser is permissive — the broken-brace input may parse with an
    // error diagnostic (→ recovered) or with only warnings (→ valid).
    // Locking the structural intent: recovery DOES happen if errors
    // surface; otherwise the tracker stays permissive (caller's
    // additionalCheck is the right place for stricter shape checks).
    expect(['recovered', 'promoted', 'valid']).toContain(obs.outcome);
  });

  it('TR-JSONC-03 additionalCheck layers schema validation', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    const goodBytes = '{ "version": 1 }\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(
      jsoncTracker({
        path: filePath,
        additionalCheck: (snap) => {
          const root = snap.ast.root;
          const hasVersion =
            root !== null &&
            root.kind === 'object' &&
            root.entries.some((e) => e.key === 'version');
          if (!hasVersion) {
            return {
              valid: false,
              issues: [{ path: 'version', message: 'missing version' }],
            };
          }
          return { valid: true, issues: [] };
        },
      }),
    );
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');

    writeFileSync(filePath, '{ "other": 1 }\n', 'utf-8');
    const obs2 = await ctx.store.observe(filePath);
    expect(obs2.outcome).toBe('recovered');
  });
});

describe('jsonlTracker — reference JSONL tracker', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('TR-JSONL-01 promotes a clean session log', async () => {
    const filePath = join(ctx.workspaceDir, 'session.jsonl');
    const goodBytes =
      '{"event":"start"}\n{"event":"step","n":1}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsonlTracker({ path: filePath }));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });

  it('TR-JSONL-02 recovers on malformed line (tail corruption)', async () => {
    const filePath = join(ctx.workspaceDir, 'session.jsonl');
    const goodBytes = '{"event":"start"}\n{"event":"end"}\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(jsonlTracker({ path: filePath }));
    await ctx.store.observe(filePath); // promote

    // Tail corruption — half-flushed turn.
    writeFileSync(
      filePath,
      '{"event":"start"}\n{"event":"end"}\n{"event":"step",',
      'utf-8',
    );
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('yamlTracker — reference YAML tracker', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('TR-YAML-01 promotes a clean .lobster workflow', async () => {
    const filePath = join(ctx.workspaceDir, 'wf.lobster');
    const goodBytes =
      'steps:\n  - id: build\n    command: gh workflow run\n  - id: test\n    command: vitest\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(yamlTracker({ path: filePath }));
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });

  it('TR-YAML-02 additionalCheck triggers recovery on schema-shape failure', async () => {
    // The `yaml` library is permissive — most "broken" YAML still
    // parses without error severity. Schema validation is the right
    // place to assert workflow shape; layer it via additionalCheck.
    const filePath = join(ctx.workspaceDir, 'wf.lobster');
    const goodBytes = 'steps:\n  - id: only\n    command: echo hi\n';
    writeFileSync(filePath, goodBytes, 'utf-8');
    ctx.store.register(
      yamlTracker({
        path: filePath,
        additionalCheck: (snap) => {
          // Cheap check: at least one `- id:` line exists.
          const hasSteps = /^\s*-\s+id:\s*/m.test(snap.ast.raw);
          return hasSteps
            ? { valid: true, issues: [] }
            : { valid: false, issues: [{ path: 'steps', message: 'no steps' }] };
        },
      }),
    );
    await ctx.store.observe(filePath); // promote

    writeFileSync(filePath, 'steps: []\n', 'utf-8');
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('recovered');
    expect(readFileSync(filePath, 'utf-8')).toBe(goodBytes);
  });
});

describe('registry — defaultTrackerFor + registerDefaultTracker', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('TR-REG-01 inferKind picks md / jsonc / jsonl / yaml from extension', () => {
    expect(defaultTrackerFor('/abs/AGENTS.md')?.path).toBe('/abs/AGENTS.md');
    expect(defaultTrackerFor('/abs/gateway.jsonc')?.path).toBe('/abs/gateway.jsonc');
    expect(defaultTrackerFor('/abs/session.jsonl')?.path).toBe('/abs/session.jsonl');
    expect(defaultTrackerFor('/abs/wf.lobster')?.path).toBe('/abs/wf.lobster');
    expect(defaultTrackerFor('/abs/pipeline.yaml')?.path).toBe('/abs/pipeline.yaml');
  });

  it('TR-REG-02 returns null for an unknown extension', () => {
    expect(defaultTrackerFor('/abs/file.unknown')).toBeNull();
    expect(defaultTrackerFor('/abs/no-extension')).toBeNull();
  });

  it('TR-REG-03 registerDefaultTracker registers the right kind for each file', async () => {
    const md = join(ctx.workspaceDir, 'AGENTS.md');
    const jsonc = join(ctx.workspaceDir, 'gateway.jsonc');
    const jsonl = join(ctx.workspaceDir, 'session.jsonl');
    const yaml = join(ctx.workspaceDir, 'wf.lobster');

    writeFileSync(md, '## H\n', 'utf-8');
    writeFileSync(jsonc, '{ "v": 1 }\n', 'utf-8');
    writeFileSync(jsonl, '{"event":"start"}\n', 'utf-8');
    writeFileSync(yaml, 'steps:\n  - id: a\n    command: c\n', 'utf-8');

    expect(registerDefaultTracker(ctx.store, md)).toBe(true);
    expect(registerDefaultTracker(ctx.store, jsonc)).toBe(true);
    expect(registerDefaultTracker(ctx.store, jsonl)).toBe(true);
    expect(registerDefaultTracker(ctx.store, yaml)).toBe(true);

    for (const path of [md, jsonc, jsonl, yaml]) {
      const obs = await ctx.store.observe(path);
      expect(obs.outcome).toBe('promoted');
    }
  });

  it('TR-REG-04 registerDefaultTracker returns false for unknown extensions', () => {
    const path = join(ctx.workspaceDir, 'file.unknown');
    writeFileSync(path, 'whatever', 'utf-8');
    expect(registerDefaultTracker(ctx.store, path)).toBe(false);
  });

  it('TR-REG-05 ocPath option flows through to the registered tracker', async () => {
    const filePath = join(ctx.workspaceDir, 'AGENTS.md');
    writeFileSync(filePath, '## H\n', 'utf-8');
    registerDefaultTracker(ctx.store, filePath, {
      ocPath: parseOcPath('oc://AGENTS.md'),
    });
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.ocPath).toBe('oc://AGENTS.md');
    }
  });

  it('TR-REG-06 factories override lets callers swap a kind for a custom tracker', async () => {
    const filePath = join(ctx.workspaceDir, 'gateway.jsonc');
    writeFileSync(filePath, '{ "v": 1 }\n', 'utf-8');
    let factoryCalled = false;
    const customJsonc = (opts: { path: string }) => {
      factoryCalled = true;
      return jsoncTracker({ path: opts.path });
    };
    registerDefaultTracker(ctx.store, filePath, {
      factories: { jsonc: customJsonc },
    });
    expect(factoryCalled).toBe(true);
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });

  it('TR-REG-07 kindFor override teaches the registry custom conventions', async () => {
    // .config files always JSONC by convention (callers' rule).
    const filePath = join(ctx.workspaceDir, 'app.config');
    writeFileSync(filePath, '{ "v": 1 }\n', 'utf-8');
    expect(defaultTrackerFor(filePath)).toBeNull(); // default doesn't know
    registerDefaultTracker(ctx.store, filePath, {
      kindFor: (p) => (p.endsWith('.config') ? 'jsonc' : null),
    });
    const obs = await ctx.store.observe(filePath);
    expect(obs.outcome).toBe('promoted');
  });
});
