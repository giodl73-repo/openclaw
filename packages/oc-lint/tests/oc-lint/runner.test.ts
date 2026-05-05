import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

function fileFromRaw(name: LintFile['name'], raw: string): LintFile {
  return { name, ast: parseMd(raw).ast };
}

const flagAlways: LintRule = {
  id: 'test/always',
  severity: 'info',
  description: 'always emits a finding',
  appliesTo: '*',
  check: () => [{ message: 'always', ocPath: 'oc://X.md', line: 1 }],
};

const flagIfHeading: LintRule = {
  id: 'test/heading',
  severity: 'warning',
  description: 'flags if file has any H2 block',
  appliesTo: '*',
  check: (ctx) => {
    if (ctx.ast.kind !== 'md') return [];
    if (ctx.ast.blocks.length === 0) return [];
    return [{ message: 'has heading', ocPath: 'oc://X.md', line: ctx.ast.blocks[0]!.line }];
  },
};

const onlyAgents: LintRule = {
  id: 'test/agents-only',
  severity: 'info',
  description: 'AGENTS.md only',
  appliesTo: 'AGENTS.md',
  check: () => [{ message: 'agents', ocPath: 'oc://AGENTS.md', line: 1 }],
};

const throwsRule: LintRule = {
  id: 'test/throws',
  severity: 'info',
  description: 'throws',
  appliesTo: '*',
  check: () => {
    throw new Error('synthetic boom');
  },
};

describe('runLint', () => {
  it('emits diagnostics with rule id + severity attached', () => {
    const r = runLint({
      rules: [flagAlways],
      files: [fileFromRaw('AGENTS.md', '## H\n')],
    });
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]).toMatchObject({
      ruleId: 'test/always',
      severity: 'info',
      fileName: 'AGENTS.md',
      message: 'always',
    });
  });

  it('skips rules whose appliesTo does not match', () => {
    const r = runLint({
      rules: [onlyAgents],
      files: [fileFromRaw('SOUL.md', '## H\n')],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.get('test/agents-only')).toBe(0);
  });

  it('appliesTo: "*" matches every file', () => {
    const r = runLint({
      rules: [flagAlways],
      files: [
        fileFromRaw('AGENTS.md', '## H\n'),
        fileFromRaw('SOUL.md', '## H\n'),
        fileFromRaw('TOOLS.md', '## H\n'),
      ],
    });
    expect(r.diagnostics.length).toBe(3);
    expect(r.stats.get('test/always')).toBe(3);
  });

  it('preserves deterministic order: outer loop = files, inner loop = rules', () => {
    const r = runLint({
      rules: [flagAlways, flagIfHeading],
      files: [fileFromRaw('AGENTS.md', '## H\n'), fileFromRaw('SOUL.md', '## H\n')],
    });
    expect(r.diagnostics.map((d) => `${d.fileName}:${d.ruleId}`)).toEqual([
      'AGENTS.md:test/always',
      'AGENTS.md:test/heading',
      'SOUL.md:test/always',
      'SOUL.md:test/heading',
    ]);
  });

  it('a rule that throws surfaces as a diagnostic but does not abort the run', () => {
    const r = runLint({
      rules: [throwsRule, flagAlways],
      files: [fileFromRaw('AGENTS.md', '## H\n')],
    });
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics[0]?.message).toContain('synthetic boom');
    expect(r.diagnostics[1]?.message).toBe('always');
  });

  it('stats counts rule invocations per applied file', () => {
    const r = runLint({
      rules: [flagAlways, onlyAgents],
      files: [
        fileFromRaw('AGENTS.md', '## H\n'),
        fileFromRaw('SOUL.md', '## H\n'),
      ],
    });
    expect(r.stats.get('test/always')).toBe(2);
    expect(r.stats.get('test/agents-only')).toBe(1);
  });

  it('empty rules list produces empty diagnostics', () => {
    const r = runLint({
      rules: [],
      files: [fileFromRaw('AGENTS.md', '## H\n')],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.size).toBe(0);
  });

  it('empty files list produces empty diagnostics', () => {
    const r = runLint({ rules: [flagAlways], files: [] });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.get('test/always')).toBe(0);
  });
});
