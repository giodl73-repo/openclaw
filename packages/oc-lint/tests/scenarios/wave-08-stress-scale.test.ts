/**
 * Wave 8 — stress + scale.
 *
 * Verify the framework handles realistically-sized rule packs and
 * workspaces without quadratic blowup or memory issues.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { LintRuleRegistry } from '../../src/oc-lint/index.js';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const file = (name: string, raw = '## H\n- item\n'): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

const noopRule = (id: string): LintRule => ({
  id,
  severity: 'info',
  description: 'noop',
  appliesTo: '*',
  check: () => [],
});

const flagRule = (id: string): LintRule => ({
  id,
  severity: 'info',
  description: 'flag',
  appliesTo: '*',
  check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 1 }],
});

describe('wave-08 stress + scale', () => {
  it('SC-01 1000 rules registered: registry size correct', () => {
    const reg = new LintRuleRegistry();
    for (let i = 0; i < 1000; i++) reg.register(noopRule(`rule-${i}`));
    expect(reg.size()).toBe(1000);
  });

  it('SC-02 1000 rules × 1 file: completes under 200 ms', () => {
    const rules = Array.from({ length: 1000 }, (_, i) => noopRule(`rule-${i}`));
    const files = [file('AGENTS.md')];
    const start = performance.now();
    const r = runLint({ rules, files });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.size).toBe(1000);
  });

  it('SC-03 100 rules × 100 files (10k invocations): under 500 ms', () => {
    const rules = Array.from({ length: 100 }, (_, i) => noopRule(`rule-${i}`));
    const files: LintFile[] = Array.from({ length: 100 }, (_, i) =>
      file(i % 2 === 0 ? 'AGENTS.md' : 'SOUL.md'),
    );
    const start = performance.now();
    runLint({ rules, files });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('SC-04 10 flag rules × 100 files: produces 1000 diagnostics', () => {
    const rules = Array.from({ length: 10 }, (_, i) => flagRule(`flag-${i}`));
    const files: LintFile[] = Array.from({ length: 100 }, () => file('AGENTS.md'));
    const r = runLint({ rules, files });
    expect(r.diagnostics.length).toBe(1000);
  });

  it('SC-05 large workspace ASTs (50 KB each) lint in reasonable time', () => {
    // Build a 50KB-ish file by repeating sections.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`## Section ${i}`);
      for (let j = 0; j < 10; j++) {
        lines.push(`- item-${i}-${j}: with content`);
      }
    }
    const raw = lines.join('\n');
    const f = file('AGENTS.md', raw);
    const rules = Array.from({ length: 50 }, (_, i) => noopRule(`r-${i}`));
    const start = performance.now();
    runLint({ rules, files: [f] });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('SC-06 deterministic stats counts under stress', () => {
    const rules = Array.from({ length: 50 }, (_, i) => noopRule(`r-${i}`));
    const files: LintFile[] = Array.from({ length: 20 }, () => file('AGENTS.md'));
    const r = runLint({ rules, files });
    for (const rule of rules) {
      expect(r.stats.get(rule.id)).toBe(20);
    }
  });

  it('SC-07 registry list-then-run round-trip stable across 100 invocations', () => {
    const reg = new LintRuleRegistry();
    for (let i = 0; i < 50; i++) reg.register(flagRule(`r-${i}`));
    const files = [file('AGENTS.md')];
    const counts: number[] = [];
    for (let n = 0; n < 100; n++) {
      const r = runLint({ rules: reg.list(), files });
      counts.push(r.diagnostics.length);
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(50);
  });

  it('SC-08 doesn\'t crash with rules that produce 1000 findings each', () => {
    const massive: LintRule = {
      id: 'massive',
      severity: 'info',
      description: 'one finding per AST line',
      appliesTo: '*',
      check: () =>
        Array.from({ length: 1000 }, (_, i) => ({
          message: `f-${i}`,
          ocPath: 'oc://X.md',
          line: i + 1,
        })),
    };
    const r = runLint({ rules: [massive], files: [file('AGENTS.md')] });
    expect(r.diagnostics.length).toBe(1000);
  });

  it('SC-09 mixed wildcard + specific rules at scale', () => {
    const rules: LintRule[] = [];
    for (let i = 0; i < 50; i++) rules.push(noopRule(`wild-${i}`));
    for (let i = 0; i < 50; i++) {
      rules.push({ ...noopRule(`agents-${i}`), appliesTo: 'AGENTS.md' });
    }
    const files = [file('AGENTS.md'), file('SOUL.md')];
    const r = runLint({ rules, files });
    // 50 wildcards × 2 files + 50 agents-only × 1 file = 100 + 50 = 150.
    let total = 0;
    for (const v of r.stats.values()) total += v;
    expect(total).toBe(150);
  });
});
