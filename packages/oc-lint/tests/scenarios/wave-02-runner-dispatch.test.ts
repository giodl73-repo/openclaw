/**
 * Wave 2 — runner dispatch.
 *
 * The runner walks files × rules, applying `appliesTo` filters. This
 * wave exercises the dispatch matrix.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const file = (name: string, raw: string = '## H\n'): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

const flagRule = (id: string, appliesTo: string): LintRule => ({
  id,
  severity: 'info',
  description: 'flags every applicable file',
  appliesTo,
  check: (ctx) => [{ message: `flag-${id}-${ctx.fileName}`, ocPath: 'oc://X.md', line: 1 }],
});

describe('wave-02 runner-dispatch', () => {
  it('D-01 empty rules + empty files: zero diagnostics', () => {
    const r = runLint({ rules: [], files: [] });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.size).toBe(0);
  });

  it('D-02 rules but no files: stats record 0 for every rule', () => {
    const r = runLint({ rules: [flagRule('a', '*'), flagRule('b', 'AGENTS.md')], files: [] });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.get('a')).toBe(0);
    expect(r.stats.get('b')).toBe(0);
  });

  it('D-03 files but no rules: zero diagnostics, no stats entries', () => {
    const r = runLint({ rules: [], files: [file('AGENTS.md'), file('SOUL.md')] });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.size).toBe(0);
  });

  it('D-04 wildcard rule applied to all 9 workspace files', () => {
    const all9: LintFile[] = [
      file('AGENTS.md'),
      file('SOUL.md'),
      file('TOOLS.md'),
      file('IDENTITY.md'),
      file('USER.md'),
      file('HEARTBEAT.md'),
      file('BOOTSTRAP.md'),
      file('MEMORY.md'),
      file('SKILL.md'),
    ];
    const r = runLint({ rules: [flagRule('all', '*')], files: all9 });
    expect(r.diagnostics.length).toBe(9);
    expect(r.stats.get('all')).toBe(9);
  });

  it('D-05 specific-file rule applied only to that file', () => {
    const r = runLint({
      rules: [flagRule('a', 'AGENTS.md')],
      files: [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md')],
    });
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.fileName).toBe('AGENTS.md');
    expect(r.stats.get('a')).toBe(1);
  });

  it('D-06 rule applied to no files in input list: 0 invocations', () => {
    const r = runLint({
      rules: [flagRule('only-soul', 'SOUL.md')],
      files: [file('AGENTS.md'), file('TOOLS.md')],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.get('only-soul')).toBe(0);
  });

  it('D-07 multiple rules with mixed appliesTo dispatch correctly', () => {
    const r = runLint({
      rules: [
        flagRule('all', '*'),
        flagRule('agents-only', 'AGENTS.md'),
        flagRule('memory-only', 'MEMORY.md'),
      ],
      files: [file('AGENTS.md'), file('SOUL.md'), file('MEMORY.md')],
    });
    // Diagnostics: all×3 + agents-only×1 + memory-only×1 = 5
    expect(r.diagnostics.length).toBe(5);
    expect(r.stats.get('all')).toBe(3);
    expect(r.stats.get('agents-only')).toBe(1);
    expect(r.stats.get('memory-only')).toBe(1);
  });

  it('D-08 same file appearing twice in input runs rules twice', () => {
    const r = runLint({
      rules: [flagRule('a', '*')],
      files: [file('AGENTS.md'), file('AGENTS.md')],
    });
    expect(r.diagnostics.length).toBe(2);
    expect(r.stats.get('a')).toBe(2);
  });

  it('D-09 rules input order preserved in dispatch', () => {
    const r = runLint({
      rules: [flagRule('z', '*'), flagRule('a', '*'), flagRule('m', '*')],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics.map((d) => d.ruleId)).toEqual(['z', 'a', 'm']);
  });

  it('D-10 files input order preserved in dispatch', () => {
    const r = runLint({
      rules: [flagRule('a', '*')],
      files: [file('TOOLS.md'), file('AGENTS.md'), file('SOUL.md')],
    });
    expect(r.diagnostics.map((d) => d.fileName)).toEqual(['TOOLS.md', 'AGENTS.md', 'SOUL.md']);
  });

  it('D-11 outer = files, inner = rules (the canonical dispatch order)', () => {
    const r = runLint({
      rules: [flagRule('rule-a', '*'), flagRule('rule-b', '*')],
      files: [file('AGENTS.md'), file('SOUL.md')],
    });
    expect(r.diagnostics.map((d) => `${d.fileName}:${d.ruleId}`)).toEqual([
      'AGENTS.md:rule-a',
      'AGENTS.md:rule-b',
      'SOUL.md:rule-a',
      'SOUL.md:rule-b',
    ]);
  });

  it('D-12 a rule applying to multiple files counts each invocation', () => {
    const r = runLint({
      rules: [flagRule('a', '*')],
      files: [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md'), file('USER.md')],
    });
    expect(r.stats.get('a')).toBe(4);
  });

  it('D-13 rule applied to empty file (no AST blocks) still invokes check', () => {
    const r = runLint({
      rules: [flagRule('a', 'AGENTS.md')],
      files: [file('AGENTS.md', '')],
    });
    expect(r.stats.get('a')).toBe(1);
  });
});

describe('wave-02 runner-dispatch — err.message scrub (C10)', () => {
  const throwingRule = (id: string, msg: string): LintRule => ({
    id,
    severity: 'warning',
    description: 'rule that throws to test scrubber',
    appliesTo: '*',
    check: () => {
      throw new Error(msg);
    },
  });

  it('SCR-01 truncates long messages', () => {
    const longMsg = 'x'.repeat(500);
    const r = runLint({
      rules: [throwingRule('long', longMsg)],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics).toHaveLength(1);
    // 256 cap, includes the "lint rule threw: " prefix.
    const m = r.diagnostics[0]!.message;
    expect(m.length).toBeLessThanOrEqual('lint rule threw: '.length + 256);
    expect(m.endsWith('...')).toBe(true);
  });

  it('SCR-02 strips ASCII control characters', () => {
    const r = runLint({
      rules: [throwingRule('ctrl', 'safe\x00\x01\x07text\x1F\x7Fmore')],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics[0]!.message).toBe('lint rule threw: safetextmore');
  });

  it('SCR-03 refuses to echo the redaction sentinel', () => {
    const r = runLint({
      rules: [throwingRule('sentinel', 'leaked __OPENCLAW_REDACTED__ here')],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics[0]!.message).not.toContain('__OPENCLAW_REDACTED__');
    expect(r.diagnostics[0]!.message).toContain('[scrubbed:');
  });
});
