/**
 * buildWorkspaceManifest tests — verifies the manifest correctly
 * walks a workspace directory and assigns each canonical openclaw
 * artifact its `oc://...` URI.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCLAW_WORKSPACE_ROLES,
  buildWorkspaceManifest,
  roleForBasename,
} from '../../../../src/plugin-sdk/oc-path/workspace/index.js';

interface Ctx {
  workspaceDir: string;
}

function makeCtx(): Ctx {
  return { workspaceDir: mkdtempSync(join(tmpdir(), 'oc-ws-')) };
}

function seedCanonical(workspaceDir: string): void {
  writeFileSync(join(workspaceDir, 'AGENTS.md'), '## Tools\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'IDENTITY.md'), '## Identity\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'gateway.jsonc'), '{ "v": 1 }\n', 'utf-8');
  writeFileSync(join(workspaceDir, 'policy.jsonc'), '{ "v": 1 }\n', 'utf-8');
  mkdirSync(join(workspaceDir, 'sessions'));
  writeFileSync(
    join(workspaceDir, 'sessions', 'session.jsonl'),
    '{"event":"start"}\n',
    'utf-8',
  );
  mkdirSync(join(workspaceDir, 'workflows'));
  writeFileSync(
    join(workspaceDir, 'workflows', 'build.lobster'),
    'steps:\n  - id: build\n    command: echo hi\n',
    'utf-8',
  );
}

describe('roleForBasename', () => {
  it('M-RB-01 matches AGENTS.md as agents.md', () => {
    expect(roleForBasename('AGENTS.md')?.id).toBe('agents.md');
  });

  it('M-RB-02 matches gateway.jsonc as config.jsonc', () => {
    expect(roleForBasename('gateway.jsonc')?.id).toBe('config.jsonc');
  });

  it('M-RB-03 matches openclaw.jsonc as config.jsonc', () => {
    expect(roleForBasename('openclaw.jsonc')?.id).toBe('config.jsonc');
  });

  it('M-RB-04 matches policy.jsonc as policy.jsonc (NOT config.jsonc)', () => {
    expect(roleForBasename('policy.jsonc')?.id).toBe('policy.jsonc');
  });

  it('M-RB-05 matches session.jsonl, audit.jsonl, events.jsonl', () => {
    expect(roleForBasename('session.jsonl')?.id).toBe('session.jsonl');
    expect(roleForBasename('audit.jsonl')?.id).toBe('session.jsonl');
    expect(roleForBasename('events.jsonl')?.id).toBe('session.jsonl');
  });

  it('M-RB-06 matches *.lobster as lobster.workflow', () => {
    expect(roleForBasename('build.lobster')?.id).toBe('lobster.workflow');
    expect(roleForBasename('test.lobster')?.id).toBe('lobster.workflow');
  });

  it('M-RB-07 returns null for non-canonical files', () => {
    expect(roleForBasename('README.md')).toBeNull();
    expect(roleForBasename('package.json')).toBeNull();
    expect(roleForBasename('random.txt')).toBeNull();
  });

  it('M-RB-08 extraRoles extends the canonical set', () => {
    const extra = [
      {
        id: 'app-config',
        kind: 'jsonc' as const,
        description: 'app config',
        matchesBasename: (n: string) => n.endsWith('.config.jsonc'),
      },
    ];
    expect(roleForBasename('my.config.jsonc', extra)?.id).toBe('app-config');
  });
});

describe('buildWorkspaceManifest', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('M-01 walks canonical artifacts and assigns ocPaths', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);

    expect(manifest.entries.length).toBe(6);
    const byRel = new Map(manifest.entries.map((e) => [e.relPath, e]));

    expect(byRel.get('AGENTS.md')?.ocPathString).toBe('oc://AGENTS.md');
    expect(byRel.get('AGENTS.md')?.ocPath).toEqual({ file: 'AGENTS.md' });
    expect(byRel.get('sessions/session.jsonl')?.ocPathString).toBe(
      'oc://sessions/session.jsonl',
    );
    expect(byRel.get('workflows/build.lobster')?.ocPathString).toBe(
      'oc://workflows/build.lobster',
    );
  });

  it('M-02 byKind summarizes the manifest', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    expect(manifest.byKind).toEqual({ md: 2, jsonc: 2, jsonl: 1, yaml: 1 });
  });

  it('M-03 byRole counts each role', async () => {
    seedCanonical(ctx.workspaceDir);
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    expect(manifest.byRole['agents.md']).toBe(1);
    expect(manifest.byRole['identity.md']).toBe(1);
    expect(manifest.byRole['config.jsonc']).toBe(1); // gateway.jsonc only
    expect(manifest.byRole['policy.jsonc']).toBe(1);
    expect(manifest.byRole['session.jsonl']).toBe(1);
    expect(manifest.byRole['lobster.workflow']).toBe(1);
  });

  it('M-04 walkedFiles counts every traversed file (including non-canonical)', async () => {
    seedCanonical(ctx.workspaceDir);
    writeFileSync(join(ctx.workspaceDir, 'README.md'), '# r\n', 'utf-8');
    writeFileSync(join(ctx.workspaceDir, 'package.json'), '{}\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    // 6 canonical + 2 non-canonical (README + package.json) = 8 walked,
    // 6 entered into manifest.
    expect(manifest.walkedFiles).toBe(8);
    expect(manifest.entries.length).toBe(6);
  });

  it('M-05 skips .git and node_modules by default', async () => {
    seedCanonical(ctx.workspaceDir);
    mkdirSync(join(ctx.workspaceDir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(
      join(ctx.workspaceDir, 'node_modules', 'foo', 'AGENTS.md'),
      '## should not appear\n',
      'utf-8',
    );
    mkdirSync(join(ctx.workspaceDir, '.git'));
    writeFileSync(join(ctx.workspaceDir, '.git', 'AGENTS.md'), '## nope\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    expect(
      manifest.entries.find((e) => e.relPath.includes('node_modules')),
    ).toBeUndefined();
    expect(
      manifest.entries.find((e) => e.relPath.includes('.git/')),
    ).toBeUndefined();
  });

  it('M-06 companion files (.lkg, .clobbered.<ts>) are filtered', async () => {
    seedCanonical(ctx.workspaceDir);
    writeFileSync(
      join(ctx.workspaceDir, 'AGENTS.md.lkg'),
      '## promoted bytes\n',
      'utf-8',
    );
    writeFileSync(
      join(ctx.workspaceDir, 'gateway.jsonc.clobbered.2025-01-01-T00-00-00-000Z'),
      '{ "v": 99 }\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    expect(
      manifest.entries.find((e) => e.relPath.endsWith('.lkg')),
    ).toBeUndefined();
    expect(
      manifest.entries.find((e) => e.relPath.includes('.clobbered.')),
    ).toBeUndefined();
  });

  it('M-07 nested per-plugin layouts produce correct relPath + ocPath', async () => {
    mkdirSync(join(ctx.workspaceDir, 'plugins', 'gateway-policy'), {
      recursive: true,
    });
    writeFileSync(
      join(ctx.workspaceDir, 'plugins', 'gateway-policy', 'AGENTS.md'),
      '## Plugin agent\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    const pluginAgents = manifest.entries.find(
      (e) => e.relPath === 'plugins/gateway-policy/AGENTS.md',
    );
    expect(pluginAgents).toBeDefined();
    expect(pluginAgents?.ocPathString).toBe(
      'oc://plugins/gateway-policy/AGENTS.md',
    );
  });

  it('M-08 abort signal stops the walk', async () => {
    seedCanonical(ctx.workspaceDir);
    const ac = new AbortController();
    ac.abort();
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir, {
      signal: ac.signal,
    });
    expect(manifest.entries.length).toBe(0);
  });

  it('M-09 OPENCLAW_WORKSPACE_ROLES count is locked', () => {
    expect(OPENCLAW_WORKSPACE_ROLES.length).toBe(11);
  });

  it('M-10 extraRoles option flows into the manifest', async () => {
    seedCanonical(ctx.workspaceDir);
    writeFileSync(
      join(ctx.workspaceDir, 'my.config.jsonc'),
      '{ "v": 1 }\n',
      'utf-8',
    );
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir, {
      extraRoles: [
        {
          id: 'app-config',
          kind: 'jsonc',
          description: 'app config',
          matchesBasename: (n: string) => n.endsWith('.config.jsonc'),
        },
      ],
    });
    const custom = manifest.entries.find((e) => e.role.id === 'app-config');
    expect(custom?.relPath).toBe('my.config.jsonc');
  });

  it('M-11 skipDirNames override completely (no merge with defaults)', async () => {
    seedCanonical(ctx.workspaceDir);
    mkdirSync(join(ctx.workspaceDir, 'custom-skip'));
    writeFileSync(
      join(ctx.workspaceDir, 'custom-skip', 'AGENTS.md'),
      '## should not appear\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir, {
      skipDirNames: ['custom-skip'],
    });
    expect(
      manifest.entries.find((e) => e.relPath.includes('custom-skip')),
    ).toBeUndefined();
  });
});
