/**
 * Wave 4 — diagnostic shape.
 *
 * The runner attaches `ruleId`, `severity`, and `fileName` to every
 * `LintFinding` from `check()`, producing a `Diagnostic`. This wave
 * verifies the shape contract.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const file = (name: LintFile['name'], raw = '## H\n'): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

describe('wave-04 diagnostic-shape', () => {
  it('DS-01 ruleId is attached', () => {
    const rule: LintRule = {
      id: 'pack/test',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 1 }],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics[0]?.ruleId).toBe('pack/test');
  });

  it('DS-02 severity is attached from rule.severity', () => {
    const info: LintRule = {
      id: 'i',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'i', ocPath: 'oc://X.md', line: 1 }],
    };
    const warn: LintRule = {
      id: 'w',
      severity: 'warning',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'w', ocPath: 'oc://X.md', line: 1 }],
    };
    const err: LintRule = {
      id: 'e',
      severity: 'error',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'e', ocPath: 'oc://X.md', line: 1 }],
    };
    const r = runLint({ rules: [info, warn, err], files: [file('AGENTS.md')] });
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['info', 'warning', 'error']);
  });

  it('DS-03 fileName is attached', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 1 }],
    };
    const r = runLint({
      rules: [rule],
      files: [file('AGENTS.md'), file('SOUL.md')],
    });
    expect(r.diagnostics.map((d) => d.fileName)).toEqual(['AGENTS.md', 'SOUL.md']);
  });

  it('DS-04 ocPath from finding is preserved', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://AGENTS.md/tools/gh', line: 5 }],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics[0]?.ocPath).toBe('oc://AGENTS.md/tools/gh');
  });

  it('DS-05 line from finding is preserved', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 42 }],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics[0]?.line).toBe(42);
  });

  it('DS-06 fixHint is propagated when present', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 1, fixHint: 'do this' }],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics[0]?.fixHint).toBe('do this');
  });

  it('DS-07 fixHint is omitted when undefined', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'm', ocPath: 'oc://X.md', line: 1 }],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect('fixHint' in (r.diagnostics[0] ?? {})).toBe(false);
  });

  it('DS-08 multiple findings from one rule preserve order', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [
        { message: 'first', ocPath: 'oc://X.md', line: 1 },
        { message: 'second', ocPath: 'oc://X.md', line: 2 },
        { message: 'third', ocPath: 'oc://X.md', line: 3 },
      ],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics.map((d) => d.message)).toEqual(['first', 'second', 'third']);
  });

  it('DS-09 zero findings produces zero diagnostics', () => {
    const rule: LintRule = {
      id: 'r',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [],
    };
    const r = runLint({ rules: [rule], files: [file('AGENTS.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('DS-10 mixing severities + multiple files produces correctly attributed diagnostics', () => {
    const ruleA: LintRule = {
      id: 'A',
      severity: 'info',
      description: 'd',
      appliesTo: '*',
      check: () => [{ message: 'a', ocPath: 'oc://X.md', line: 1 }],
    };
    const ruleB: LintRule = {
      id: 'B',
      severity: 'warning',
      description: 'd',
      appliesTo: 'AGENTS.md',
      check: () => [{ message: 'b', ocPath: 'oc://X.md', line: 1 }],
    };
    const r = runLint({
      rules: [ruleA, ruleB],
      files: [file('AGENTS.md'), file('SOUL.md')],
    });
    // AGENTS.md gets both A + B; SOUL.md gets only A.
    expect(r.diagnostics.length).toBe(3);
    const profile = r.diagnostics.map((d) => `${d.fileName}:${d.ruleId}:${d.severity}`);
    expect(profile).toEqual([
      'AGENTS.md:A:info',
      'AGENTS.md:B:warning',
      'SOUL.md:A:info',
    ]);
  });
});
