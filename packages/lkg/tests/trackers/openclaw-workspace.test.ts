/**
 * registerOpenClawWorkspace tests — verifies the LKG-side registrar
 * correctly consumes a `WorkspaceManifest` (built via oc-paths-
 * substrate's `buildWorkspaceManifest`) and registers each canonical
 * artifact with the right tracker.
 *
 * The manifest layer is tested in oc-path; this suite
 * focuses on the manifest → tracker registration mapping.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCLAW_WORKSPACE_ROLES,
  buildWorkspaceManifest,
} from '@openclaw/oc-path';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../../src/extensions/lkg-fs/index.js';
import {
  registerOpenClawWorkspace,
  registerOpenClawWorkspaceFromDir,
} from '../../src/trackers/index.js';

interface Ctx {
  store: FsLKGStore;
  audit: InMemoryAuditSink;
  notices: InMemoryRecoveryNoticeSink;
  workspaceDir: string;
}

function makeCtx(): Ctx {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-ws-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  return { store, audit, notices, workspaceDir };
}

function seedCanonical(workspaceDir: string): void {
  // Tier 1 — agent core (md)
  writeFileSync(join(workspaceDir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'IDENTITY.md'), '## Identity\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'MEMORY.md'), '## Memory\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'SKILL.md'), '---\ntier: 1\n---\n## Skill\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'TOOLS.md'), '## Tools\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'USER.md'), '## User\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'SOUL.md'), '## Soul\n', 'utf-8');

  // Tier 2 — config (jsonc)
  writeFileSync(join(workspaceDir, 'gateway.jsonc'), '{ "version": 1 }\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'openclaw.jsonc'), '{ "version": 1 }\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'config.jsonc'), '{ "version": 1 }\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'policy.jsonc'), '{ "version": 1 }\n', 'utf-8');

  // Tier 3 — sessions (jsonl)
  mkdirSync(join(workspaceDir, 'sessions'));
  writeFileSync(
    join(workspaceDir, 'sessions', 'session.jsonl'),
    '{"event":"start"}\n{"event":"end"}\n',
    'utf-8',
  );
  writeFileSync(
    join(workspaceDir, 'sessions', 'audit.jsonl'),
    '{"event":"audit"}\n',
    'utf-8',
  );

  // Tier 4 — workflows (yaml/.lobster)
  mkdirSync(join(workspaceDir, 'workflows'));
  writeFileSync(
    join(workspaceDir, 'workflows', 'build.lobster'),
    'steps:\n  - id: build\n    command: echo hi\n',
    'utf-8',
  );
  writeFileSync(
    join(workspaceDir, 'workflows', 'test.lobster'),
    'steps:\n  - id: test\n    command: vitest\n',
    'utf-8',
  );
}

function seedNoise(workspaceDir: string): void {
  writeFileSync(join(workspaceDir, 'README.md'), '# README\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'package.json'), '{}\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'random.txt'), 'whatever\n', 'utf-8');

  mkdirSync(join(workspaceDir, 'node_modules', 'foo'), { recursive: true });
  writeFileSync(
    join(workspaceDir, 'node_modules', 'foo', 'AGENTS.md'),
    '## Should not be tracked\n',
    'utf-8',
  );
  mkdirSync(join(workspaceDir, '.git'));
  writeFileSync(join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
}

describe('registerOpenClawWorkspace — opinionated registrar', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('OW-01 registers every manifest entry with the right tracker', async () => {
    seedCanonical(ctx.workspaceDir);
    seedNoise(ctx.workspaceDir);

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    // 7 md + 4 jsonc + 2 jsonl + 2 yaml = 15
    expect(result.registered.length).toBe(15);
    expect(result.skipped.length).toBe(0);
    expect(result.byKind).toEqual({ md: 7, jsonc: 4, jsonl: 2, yaml: 2 });
  });

  it('OW-02 each registered entry carries its workspace-relative ocPath', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    const session = result.registered.find(
      (r) => r.relPath === 'sessions/session.jsonl',
    );
    expect(session?.ocPath).toBe('oc://sessions/session.jsonl');

    const agents = result.registered.find((r) => r.relPath === 'AGENTS.md');
    expect(agents?.ocPath).toBe('oc://AGENTS.md');
  });

  it('OW-03 byRole counts canonical roles correctly', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    expect(result.byRole['agents.md']).toBe(1);
    expect(result.byRole['identity.md']).toBe(1);
    expect(result.byRole['config.jsonc']).toBe(3); // gateway + openclaw + config
    expect(result.byRole['policy.jsonc']).toBe(1);
    expect(result.byRole['session.jsonl']).toBe(2); // session + audit
    expect(result.byRole['lobster.workflow']).toBe(2);
  });

  it('OW-04 registered trackers actually drive the LKG lifecycle', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    registerOpenClawWorkspace(ctx.store, manifest);

    // Observe AGENTS.md — should promote.
    const agentsPath = join(ctx.workspaceDir, 'AGENTS.md');
    const obs = await ctx.store.observe(agentsPath);
    expect(obs.outcome).toBe('promoted');
    if (obs.outcome === 'promoted') {
      expect(obs.ocPath).toBe('oc://AGENTS.md');
    }

    const gw = join(ctx.workspaceDir, 'gateway.jsonc');
    const obsGw = await ctx.store.observe(gw);
    expect(obsGw.outcome).toBe('promoted');
  });

  it('OW-05 a second registration records collisions in skipped (idempotent)', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);

    const first = registerOpenClawWorkspace(ctx.store, manifest);
    expect(first.skipped.length).toBe(0);

    const second = registerOpenClawWorkspace(ctx.store, manifest);
    expect(second.registered.length).toBe(0);
    expect(second.skipped.every((s) => s.reason === 'collision')).toBe(true);
    expect(second.skipped.length).toBe(first.registered.length);
  });

  it('OW-06 extraRoles flow through the manifest builder', async () => {
    seedCanonical(ctx.workspaceDir);
    writeFileSync(
      join(ctx.workspaceDir, 'my-app.config.jsonc'),
      '{ "v": 1 }\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir, {
      extraRoles: [
        {
          id: 'app-config',
          kind: 'jsonc',
          description: 'App-specific config',
          matchesBasename: (n: string) => n.endsWith('.config.jsonc'),
        },
      ],
    });
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    const custom = result.registered.find(
      (r) => r.role.id === 'app-config' && r.relPath === 'my-app.config.jsonc',
    );
    expect(custom).toBeDefined();
  });

  it('OW-07 walks nested per-plugin AGENTS.md correctly', async () => {
    mkdirSync(join(ctx.workspaceDir, 'plugins', 'gateway-policy'), {
      recursive: true,
    });
    writeFileSync(
      join(ctx.workspaceDir, 'plugins', 'gateway-policy', 'AGENTS.md'),
      '## Plugin agent\n',
      'utf-8',
    );
    writeFileSync(
      join(ctx.workspaceDir, 'plugins', 'gateway-policy', 'openclaw.jsonc'),
      '{ "v": 1 }\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    const pluginAgents = result.registered.find(
      (r) => r.relPath === 'plugins/gateway-policy/AGENTS.md',
    );
    expect(pluginAgents?.ocPath).toBe('oc://plugins/gateway-policy/AGENTS.md');

    const pluginConfig = result.registered.find(
      (r) => r.relPath === 'plugins/gateway-policy/openclaw.jsonc',
    );
    expect(pluginConfig).toBeDefined();
  });

  it('OW-08 .git and node_modules are skipped by default', async () => {
    seedCanonical(ctx.workspaceDir);
    seedNoise(ctx.workspaceDir);

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    expect(
      result.registered.find((r) => r.relPath.includes('node_modules')),
    ).toBeUndefined();
    expect(
      result.registered.find((r) => r.relPath.includes('.git/')),
    ).toBeUndefined();
  });

  it('OW-09 companion files are never registered as trackers', async () => {
    seedCanonical(ctx.workspaceDir);
    writeFileSync(
      join(ctx.workspaceDir, 'AGENTS.md.lkg'),
      '## old promoted bytes\n',
      'utf-8',
    );
    writeFileSync(
      join(ctx.workspaceDir, 'gateway.jsonc.clobbered.2025-01-01-T00-00-00-000Z'),
      '{ "v": 99 }\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const result = registerOpenClawWorkspace(ctx.store, manifest);

    expect(
      result.registered.find((r) => r.relPath.endsWith('.lkg')),
    ).toBeUndefined();
    expect(
      result.registered.find((r) => r.relPath.includes('.clobbered.')),
    ).toBeUndefined();
  });

  it('OW-10 abort signal stops the manifest walk', async () => {
    seedCanonical(ctx.workspaceDir);
    const ac = new AbortController();
    ac.abort();
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir, {
      signal: ac.signal,
    });
    const result = registerOpenClawWorkspace(ctx.store, manifest);
    expect(result.registered.length).toBe(0);
  });

  it('OW-11 OPENCLAW_WORKSPACE_ROLES is exported as the canonical list (from oc-paths)', () => {
    expect(OPENCLAW_WORKSPACE_ROLES.length).toBe(11);
    const ids = OPENCLAW_WORKSPACE_ROLES.map((r) => r.id);
    expect(ids).toContain('agents.md');
    expect(ids).toContain('config.jsonc');
    expect(ids).toContain('session.jsonl');
    expect(ids).toContain('lobster.workflow');
  });

  it('OW-12 registerOpenClawWorkspaceFromDir is a one-call convenience', async () => {
    seedCanonical(ctx.workspaceDir);
    const result = await registerOpenClawWorkspaceFromDir(
      ctx.store,
      ctx.workspaceDir,
    );
    expect(result.registered.length).toBe(15);
    expect(result.manifest.entries.length).toBe(15);
    expect(result.manifest.byKind.md).toBe(7);
  });
});
