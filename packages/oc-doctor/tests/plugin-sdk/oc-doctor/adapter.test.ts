import { describe, expect, it } from 'vitest';
import { ocPathFixerContribution } from '../../../src/plugin-sdk/oc-doctor/adapter.js';
import type {
  DoctorContext,
  OcPathFixerSpec,
} from '../../../src/plugin-sdk/oc-doctor/types.js';
import { makeDoctorFile } from '../../test-helpers.js';
import { syntheticFinding, syntheticMatch } from '../../test-match.js';

const noopSpec: OcPathFixerSpec = {
  id: 'test/noop',
  description: 'noop',
  severity: 'info',
  appliesTo: 'AGENTS.md',
  detect: () => [],
  fix: ({ raw }) => raw,
};

const flagSpec: OcPathFixerSpec = {
  id: 'test/flag',
  description: 'flag',
  severity: 'info',
  appliesTo: 'AGENTS.md',
  detect: ({ ast }) => {
    if (ast.kind !== 'md') return [];
    if (ast.blocks.some((b) => b.slug === 'fixed')) return [];
    return [
      {
        match: syntheticMatch('oc://AGENTS.md'),
        message: 'needs Fixed section',
        fixHint: 'append `## Fixed`',
      },
    ];
  },
  fix: ({ raw, ast }) => {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'fixed')) return raw;
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + '\n## Fixed\n';
  },
};

interface MockCtx {
  ctx: DoctorContext;
  writes: Map<string, string>;
}

function mockCtx(files: { name: string; raw: string }[]): MockCtx {
  const writes = new Map<string, string>();
  return {
    writes,
    ctx: {
      workspaceDir: '/ws',
      files: files.map((f) => makeDoctorFile(f.name, `/ws/${f.name}`, f.raw)),
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    },
  };
}

describe('ocPathFixerContribution adapter', () => {
  it('A-01 produces a contribution with the spec id + description', () => {
    const c = ocPathFixerContribution(noopSpec);
    expect(c.id).toBe('test/noop');
    expect(c.description).toBe('noop');
  });

  it('A-02 detect returns empty when spec.detect returns empty', async () => {
    const c = ocPathFixerContribution(noopSpec);
    const m = mockCtx([{ name: 'AGENTS.md', raw: '## H\n- a\n' }]);
    const findings = await c.detect(m.ctx);
    expect(findings).toEqual([]);
  });

  it('A-03 detect skips files whose name does not match appliesTo', async () => {
    const c = ocPathFixerContribution(flagSpec); // applies to AGENTS.md
    const m = mockCtx([{ name: 'SOUL.md', raw: '## H\n' }]);
    const findings = await c.detect(m.ctx);
    expect(findings).toEqual([]);
  });

  it('A-04 detect attaches contributionId + severity + filePath to findings', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = mockCtx([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const [f] = await c.detect(m.ctx);
    expect(f).toMatchObject({
      contributionId: 'test/flag',
      severity: 'info',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
    });
  });

  it('A-05 fix calls writeFile with the new bytes', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = mockCtx([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const [finding] = await c.detect(m.ctx);
    const result = await c.fix(m.ctx, finding!);
    expect(result.outcome).toBe('fixed');
    expect(m.writes.get('/ws/AGENTS.md')).toContain('## Fixed');
  });

  it('A-06 fix returns "skipped" when the fix is a no-op', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const alreadyFixed = '## H\n\n## Fixed\n';
    const m = mockCtx([{ name: 'AGENTS.md', raw: alreadyFixed }]);
    const synthFinding = syntheticFinding({
      contributionId: 'test/flag',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
      ocPath: 'oc://AGENTS.md',
      message: 'x',
    });
    const result = await c.fix(m.ctx, synthFinding);
    expect(result.outcome).toBe('skipped');
  });

  it('A-07 fix returns "failed" when the file is not in the context', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = mockCtx([]);
    const synthFinding = syntheticFinding({
      contributionId: 'test/flag',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
      ocPath: 'oc://AGENTS.md',
      message: 'x',
    });
    const result = await c.fix(m.ctx, synthFinding);
    expect(result.outcome).toBe('failed');
  });

  it('A-08 fix returns "failed" if writeFile throws', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const ctx: DoctorContext = {
      workspaceDir: '/ws',
      files: [makeDoctorFile('AGENTS.md', '/ws/AGENTS.md', '## H\n')],
      writeFile: async () => {
        throw new Error('disk full');
      },
    };
    const [finding] = await c.detect(ctx);
    const result = await c.fix(ctx, finding!);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') expect(result.reason).toContain('disk full');
  });

  it('A-09 detect line numbers + ocPath flow through to the finding', async () => {
    const spec: OcPathFixerSpec = {
      ...flagSpec,
      detect: () => [
        {
          match: syntheticMatch('oc://AGENTS.md/specific/path', 42),
          message: 'x',
          fixHint: 'h',
        },
      ],
    };
    const c = ocPathFixerContribution(spec);
    const m = mockCtx([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const [finding] = await c.detect(m.ctx);
    expect(finding?.ocPath).toBe('oc://AGENTS.md/specific/path');
    expect(finding?.line).toBe(42);
    expect(finding?.fixHint).toBe('h');
  });

  it('A-10 adapter is non-mutating with respect to spec', () => {
    const spec = { ...flagSpec };
    const before = JSON.stringify({ ...spec, detect: undefined, fix: undefined });
    ocPathFixerContribution(spec);
    const after = JSON.stringify({ ...spec, detect: undefined, fix: undefined });
    expect(after).toBe(before);
  });
});
