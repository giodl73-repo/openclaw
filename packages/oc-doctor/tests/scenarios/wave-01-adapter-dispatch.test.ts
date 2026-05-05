/**
 * Wave 1 — adapter dispatch.
 *
 * `ocPathFixerContribution` correctly dispatches detect + fix across
 * varying file-name + path combinations. The contribution shape mirrors
 * upstream's `DoctorHealthContribution` slot.
 */
import { describe, expect, it } from 'vitest';
import { ocPathFixerContribution } from '../../src/plugin-sdk/oc-doctor/adapter.js';
import type {
  DoctorContext,
  DoctorFinding,
  OcPathFixerSpec,
} from '../../src/plugin-sdk/oc-doctor/types.js';
import { makeDoctorFile } from '../test-helpers.js';
import { syntheticFinding, syntheticMatch } from '../test-match.js';

const flagSpec: OcPathFixerSpec = {
  id: 'test/flag',
  description: 'flag if no Done section',
  severity: 'info',
  appliesTo: 'AGENTS.md',
  detect: ({ ast }) => {
    if (ast.kind !== 'md') return [];
    return ast.blocks.some((b) => b.slug === 'done')
      ? []
      : [{ match: syntheticMatch('oc://AGENTS.md'), message: 'no done' }];
  },
  fix: ({ raw, ast }) => {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'done')) return raw;
    return raw.endsWith('\n') ? raw + '\n## Done\n' : raw + '\n\n## Done\n';
  },
};

interface MockCtx {
  ctx: DoctorContext;
  writes: Map<string, string>;
}

function ctxOf(files: { name: string; raw: string }[]): MockCtx {
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

describe('wave-01 adapter-dispatch', () => {
  it('AD-01 detect on empty workspace returns no findings', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([]);
    const findings = await c.detect(m.ctx);
    expect(findings).toEqual([]);
  });

  it('AD-02 detect skips files whose name does not match appliesTo', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([
      { name: 'SOUL.md', raw: '## H\n' },
      { name: 'TOOLS.md', raw: '## H\n' },
    ]);
    const findings = await c.detect(m.ctx);
    expect(findings).toEqual([]);
  });

  it('AD-03 detect runs against multiple files of the same matching name', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([
      { name: 'AGENTS.md', raw: '## A\n' },
      { name: 'AGENTS.md', raw: '## B\n' },
    ]);
    const findings = await c.detect(m.ctx);
    expect(findings.length).toBe(2);
  });

  it('AD-04 detect findings carry contributionId, severity, fileName, filePath', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const [f] = await c.detect(m.ctx);
    expect(f).toMatchObject({
      contributionId: 'test/flag',
      severity: 'info',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
      line: 1,
    });
  });

  it('AD-05 fix succeeds on a flagged file: writes new bytes, returns "fixed"', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const [finding] = await c.detect(m.ctx);
    const result = await c.fix(m.ctx, finding!);
    expect(result.outcome).toBe('fixed');
    expect(m.writes.get('/ws/AGENTS.md')).toContain('## Done');
  });

  it('AD-06 fix on already-correct file returns "skipped"', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([{ name: 'AGENTS.md', raw: '## H\n## Done\n' }]);
    const synth: DoctorFinding = syntheticFinding({
      contributionId: 'test/flag',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
      ocPath: 'oc://AGENTS.md',
      message: 'x',
    });
    const result = await c.fix(m.ctx, synth);
    expect(result.outcome).toBe('skipped');
  });

  it('AD-07 fix on missing file returns "failed"', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([]);
    const synth: DoctorFinding = syntheticFinding({
      contributionId: 'test/flag',
      fileName: 'AGENTS.md',
      filePath: '/ws/AGENTS.md',
      ocPath: 'oc://AGENTS.md',
      message: 'x',
    });
    const result = await c.fix(m.ctx, synth);
    expect(result.outcome).toBe('failed');
  });

  it('AD-08 fix surfaces writeFile errors as "failed"', async () => {
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

  it('AD-09 fix returns "skipped" if file in context is for the wrong appliesTo', async () => {
    const wrongFileSpec: OcPathFixerSpec = {
      ...flagSpec,
      appliesTo: 'MEMORY.md',
    };
    const c = ocPathFixerContribution(wrongFileSpec);
    const synth: DoctorFinding = syntheticFinding({
      contributionId: 'test/flag',
      fileName: 'AGENTS.md', // intentionally mismatched with the spec
      filePath: '/ws/AGENTS.md',
      ocPath: 'oc://AGENTS.md',
      message: 'x',
    });
    const m = ctxOf([{ name: 'AGENTS.md', raw: '## H\n' }]);
    const result = await c.fix(m.ctx, synth);
    expect(result.outcome).toBe('skipped');
  });

  it('AD-10 detect on multiple files writes findings in input order', async () => {
    const c = ocPathFixerContribution(flagSpec);
    const m = ctxOf([
      { name: 'SOUL.md', raw: '## H\n' }, // skipped
      { name: 'AGENTS.md', raw: '## A\n' }, // flag
      { name: 'TOOLS.md', raw: '## H\n' }, // skipped
      { name: 'AGENTS.md', raw: '## B\n' }, // flag
    ]);
    const findings = await c.detect(m.ctx);
    expect(findings.length).toBe(2);
    expect(findings[0]?.fileName).toBe('AGENTS.md');
    expect(findings[1]?.fileName).toBe('AGENTS.md');
  });
});
