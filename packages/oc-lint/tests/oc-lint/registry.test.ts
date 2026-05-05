import { describe, expect, it } from 'vitest';
import { LintRuleRegistry } from '../../src/oc-lint/index.js';
import {
  LintRuleRegistrationError,
  type LintRule,
} from '../../src/plugin-sdk/oc-lint/index.js';

const noopRule = (id: string): LintRule => ({
  id,
  severity: 'info',
  description: 'noop',
  appliesTo: '*',
  check: () => [],
});

describe('LintRuleRegistry', () => {
  it('registers + lists rules in insertion order', () => {
    const r = new LintRuleRegistry();
    r.register(noopRule('a'));
    r.register(noopRule('b'));
    r.register(noopRule('c'));
    expect(r.list().map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('size() reflects registered count', () => {
    const r = new LintRuleRegistry();
    expect(r.size()).toBe(0);
    r.register(noopRule('a'));
    expect(r.size()).toBe(1);
  });

  it('get() returns the registered rule', () => {
    const r = new LintRuleRegistry();
    const rule = noopRule('x');
    r.register(rule);
    expect(r.get('x')).toBe(rule);
    expect(r.get('y')).toBeUndefined();
  });

  it('throws on duplicate id with stable error code', () => {
    const r = new LintRuleRegistry();
    r.register(noopRule('dup'));
    try {
      r.register(noopRule('dup'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LintRuleRegistrationError);
      expect((err as LintRuleRegistrationError).code).toBe('OC_LINT_DUPLICATE_RULE');
      expect((err as LintRuleRegistrationError).ruleId).toBe('dup');
    }
  });

  it('clearForTest empties the registry', () => {
    const r = new LintRuleRegistry();
    r.register(noopRule('a'));
    r.register(noopRule('b'));
    r.clearForTest();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
  });
});
