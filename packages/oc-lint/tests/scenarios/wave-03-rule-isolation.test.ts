/**
 * Wave 3 — rule isolation.
 *
 * One rule's failure must not affect other rules' results. The runner
 * wraps each `check()` in try/catch, surfaces the failure as a
 * diagnostic, and continues with surviving rules.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const file = (name: LintFile['name'], raw = '## H\n'): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

const okRule: LintRule = {
  id: 'ok',
  severity: 'info',
  description: 'returns one finding',
  appliesTo: '*',
  check: () => [{ message: 'ok', ocPath: 'oc://X.md', line: 1 }],
};

const throwsErrorRule: LintRule = {
  id: 'throws-error',
  severity: 'info',
  description: 'throws an Error',
  appliesTo: '*',
  check: () => {
    throw new Error('boom error');
  },
};

const throwsStringRule: LintRule = {
  id: 'throws-string',
  severity: 'info',
  description: 'throws a string',
  appliesTo: '*',
  check: () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw 'boom string';
  },
};

const throwsObjectRule: LintRule = {
  id: 'throws-object',
  severity: 'info',
  description: 'throws an object',
  appliesTo: '*',
  check: () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw { foo: 'bar' };
  },
};

const throwsNullRule: LintRule = {
  id: 'throws-null',
  severity: 'info',
  description: 'throws null',
  appliesTo: '*',
  check: () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw null;
  },
};

describe('wave-03 rule-isolation', () => {
  it('I-01 rule that throws Error: surfaces as diagnostic, run continues', () => {
    const r = runLint({
      rules: [throwsErrorRule, okRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics[0]?.message).toContain('boom error');
    expect(r.diagnostics[1]?.message).toBe('ok');
  });

  it('I-02 rule that throws a string: still surfaces', () => {
    const r = runLint({
      rules: [throwsStringRule, okRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics[0]?.message).toContain('boom string');
    expect(r.diagnostics[1]?.message).toBe('ok');
  });

  it('I-03 rule that throws an object: surfaces using stringification', () => {
    const r = runLint({
      rules: [throwsObjectRule, okRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics[0]?.ruleId).toBe('throws-object');
    expect(r.diagnostics[1]?.ruleId).toBe('ok');
  });

  it('I-04 rule that throws null: surfaces without crashing', () => {
    const r = runLint({
      rules: [throwsNullRule, okRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics.length).toBe(2);
  });

  it('I-05 thrown rule\'s diagnostic carries the rule\'s declared severity', () => {
    const warnThrow: LintRule = {
      id: 'warn-throw',
      severity: 'warning',
      description: 'warn-level rule that throws',
      appliesTo: '*',
      check: () => {
        throw new Error('x');
      },
    };
    const r = runLint({ rules: [warnThrow], files: [file('AGENTS.md')] });
    expect(r.diagnostics[0]?.severity).toBe('warning');
  });

  it('I-06 thrown rule still counts as an invocation', () => {
    const r = runLint({ rules: [throwsErrorRule], files: [file('AGENTS.md')] });
    expect(r.stats.get('throws-error')).toBe(1);
  });

  it('I-07 multiple rules throw: each independently surfaces', () => {
    const r = runLint({
      rules: [throwsErrorRule, throwsStringRule, okRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics.length).toBe(3);
    const ids = r.diagnostics.map((d) => d.ruleId);
    expect(ids).toContain('throws-error');
    expect(ids).toContain('throws-string');
    expect(ids).toContain('ok');
  });

  it('I-08 thrown-rule diagnostic uses the file\'s OcPath as a fallback location', () => {
    const r = runLint({
      rules: [throwsErrorRule],
      files: [file('AGENTS.md')],
    });
    expect(r.diagnostics[0]?.ocPath).toBe('oc://AGENTS.md');
    expect(r.diagnostics[0]?.line).toBe(1);
  });

  it('I-09 a rule that throws on file A still runs on file B', () => {
    let callCount = 0;
    const flakyRule: LintRule = {
      id: 'flaky',
      severity: 'info',
      description: 'flaky rule (throws on first invocation, succeeds on subsequent)',
      appliesTo: '*',
      check: () => {
        callCount++;
        if (callCount === 1) throw new Error('first call boom');
        return [{ message: 'ok', ocPath: 'oc://X.md', line: 1 }];
      },
    };
    const r = runLint({
      rules: [flakyRule],
      files: [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md')],
    });
    expect(r.diagnostics.length).toBe(3);
    expect(r.diagnostics[0]?.message).toContain('first call boom');
    expect(r.diagnostics[1]?.message).toBe('ok');
    expect(r.diagnostics[2]?.message).toBe('ok');
  });

  it('I-10 rule check is called with a fresh ctx each time (no shared state)', () => {
    const seen: string[] = [];
    const introspectRule: LintRule = {
      id: 'introspect',
      severity: 'info',
      description: 'records the file name it was called with',
      appliesTo: '*',
      check: (ctx) => {
        seen.push(ctx.fileName);
        return [];
      },
    };
    runLint({
      rules: [introspectRule],
      files: [file('AGENTS.md'), file('SOUL.md'), file('TOOLS.md')],
    });
    expect(seen).toEqual(['AGENTS.md', 'SOUL.md', 'TOOLS.md']);
  });
});
