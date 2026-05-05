/**
 * Wave 5 — ordering determinism + non-mutation.
 *
 * Same inputs → same outputs. Runner does not mutate inputs. Stats
 * accuracy across multiple invocations.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { LintRuleRegistry } from '../../src/oc-lint/index.js';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const file = (name: LintFile['name'], raw = '## H\n- a\n- b\n'): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

const rule = (id: string, count: number): LintRule => ({
  id,
  severity: 'info',
  description: 'd',
  appliesTo: '*',
  check: () =>
    Array.from({ length: count }, (_, i) => ({
      message: `${id}-${i}`,
      ocPath: 'oc://X.md',
      line: i + 1,
    })),
});

describe('wave-05 determinism', () => {
  it('DT-01 same inputs → same diagnostics across runs', () => {
    const rules = [rule('a', 2), rule('b', 1), rule('c', 3)];
    const files = [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md')];
    const r1 = runLint({ rules, files });
    const r2 = runLint({ rules, files });
    const r3 = runLint({ rules, files });
    expect(r1.diagnostics).toEqual(r2.diagnostics);
    expect(r2.diagnostics).toEqual(r3.diagnostics);
  });

  it('DT-02 stats counts are stable across runs', () => {
    const rules = [rule('a', 1), rule('b', 1)];
    const files = [file('AGENTS.md'), file('SOUL.md')];
    const r1 = runLint({ rules, files });
    const r2 = runLint({ rules, files });
    expect([...r1.stats.entries()]).toEqual([...r2.stats.entries()]);
  });

  it('DT-03 runner does not mutate the rules array', () => {
    const rules = [rule('a', 1), rule('b', 1)];
    const before = JSON.stringify(rules.map((r) => r.id));
    runLint({ rules, files: [file('AGENTS.md')] });
    expect(JSON.stringify(rules.map((r) => r.id))).toBe(before);
  });

  it('DT-04 runner does not mutate file ASTs', () => {
    const f = file('AGENTS.md');
    const before = JSON.stringify(f.ast);
    runLint({ rules: [rule('a', 5)], files: [f] });
    expect(JSON.stringify(f.ast)).toBe(before);
  });

  it('DT-05 ordering deterministic with mixed appliesTo + multiple files', () => {
    const a = rule('a', 1);
    const b: LintRule = { ...rule('b', 1), appliesTo: 'AGENTS.md' };
    const c: LintRule = { ...rule('c', 1), appliesTo: 'SOUL.md' };
    const r = runLint({
      rules: [a, b, c],
      files: [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md')],
    });
    const profile = r.diagnostics.map((d) => `${d.fileName}:${d.ruleId}`);
    expect(profile).toEqual([
      'AGENTS.md:a',
      'AGENTS.md:b',
      'SOUL.md:a',
      'SOUL.md:c',
      'TOOLS.md:a',
    ]);
  });

  it('DT-06 stats include 0-count rules (skipped due to appliesTo mismatch)', () => {
    const r = runLint({
      rules: [rule('a', 1), { ...rule('b', 1), appliesTo: 'MEMORY.md' }],
      files: [file('AGENTS.md')],
    });
    expect(r.stats.get('a')).toBe(1);
    expect(r.stats.get('b')).toBe(0);
    expect(r.stats.size).toBe(2);
  });

  it('DT-07 deterministic registry insertion-order roundtrips through runner', () => {
    const reg = new LintRuleRegistry();
    reg.register(rule('z', 1));
    reg.register(rule('a', 1));
    reg.register(rule('m', 1));
    const r = runLint({ rules: reg.list(), files: [file('AGENTS.md')] });
    expect(r.diagnostics.map((d) => d.ruleId)).toEqual(['z', 'a', 'm']);
  });

  it('DT-08 multi-finding ordering preserved within rule', () => {
    const r = runLint({ rules: [rule('multi', 5)], files: [file('AGENTS.md')] });
    expect(r.diagnostics.map((d) => d.message)).toEqual([
      'multi-0',
      'multi-1',
      'multi-2',
      'multi-3',
      'multi-4',
    ]);
  });

  it('DT-09 stats counters increment correctly across many invocations of same registry', () => {
    const rules = [rule('a', 1)];
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const r = runLint({ rules, files: [file('AGENTS.md')] });
      total += r.stats.get('a') ?? 0;
    }
    expect(total).toBe(10);
  });
});
