/**
 * Wave 1 — registry edges.
 *
 * `LintRuleRegistry` invariants: insertion-order preservation, duplicate
 * rejection with stable error code, lookup by id, size accounting.
 */
import { describe, expect, it } from 'vitest';
import { LintRuleRegistry } from '../../src/oc-lint/index.js';
import {
  LintRuleRegistrationError,
  type LintRule,
} from '../../src/plugin-sdk/oc-lint/index.js';

const rule = (id: string): LintRule => ({
  id,
  severity: 'info',
  description: 'noop',
  appliesTo: '*',
  check: () => [],
});

describe('wave-01 registry-edges', () => {
  it('R-01 empty registry: size 0, list empty', () => {
    const r = new LintRuleRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
    expect(r.get('any')).toBeUndefined();
  });

  it('R-02 single rule registered + retrievable', () => {
    const r = new LintRuleRegistry();
    const x = rule('x');
    r.register(x);
    expect(r.size()).toBe(1);
    expect(r.get('x')).toBe(x);
    expect(r.list()).toEqual([x]);
  });

  it('R-03 1000 rules registered, list preserves insertion order', () => {
    const r = new LintRuleRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `pack/rule-${i.toString().padStart(4, '0')}`;
      ids.push(id);
      r.register(rule(id));
    }
    expect(r.size()).toBe(1000);
    expect(r.list().map((x) => x.id)).toEqual(ids);
  });

  it('R-04 duplicate id rejected with stable code', () => {
    const r = new LintRuleRegistry();
    r.register(rule('dup'));
    expect(() => r.register(rule('dup'))).toThrow(LintRuleRegistrationError);
    try {
      r.register(rule('dup'));
    } catch (err) {
      expect((err as LintRuleRegistrationError).code).toBe('OC_LINT_DUPLICATE_RULE');
      expect((err as LintRuleRegistrationError).ruleId).toBe('dup');
    }
  });

  it('R-05 case-sensitive id matching ("Foo" and "foo" are distinct)', () => {
    const r = new LintRuleRegistry();
    r.register(rule('Foo'));
    expect(() => r.register(rule('foo'))).not.toThrow();
    expect(r.size()).toBe(2);
  });

  it('R-06 trailing-whitespace ids are distinct (stable, not normalized)', () => {
    const r = new LintRuleRegistry();
    r.register(rule('a'));
    expect(() => r.register(rule('a '))).not.toThrow();
    expect(r.size()).toBe(2);
  });

  it('R-07 list() returns a fresh copy each call (does not expose internal map)', () => {
    const r = new LintRuleRegistry();
    r.register(rule('a'));
    const list1 = r.list();
    const list2 = r.list();
    expect(list1).not.toBe(list2);
    expect(list1).toEqual(list2);
  });

  it('R-08 mutating returned list does not affect registry', () => {
    const r = new LintRuleRegistry();
    r.register(rule('a'));
    const list = r.list() as LintRule[];
    list.push(rule('mutation'));
    expect(r.size()).toBe(1);
  });

  it('R-09 empty-string id is registerable (caller responsibility to validate)', () => {
    // Substrate stays opinion-free about id shape; rule packs validate
    // their own ids before registering. This test documents the
    // permissive policy.
    const r = new LintRuleRegistry();
    expect(() => r.register(rule(''))).not.toThrow();
  });

  it('R-10 special-character ids preserved', () => {
    const r = new LintRuleRegistry();
    const id = 'pack/with-special:chars/and@symbol';
    r.register(rule(id));
    expect(r.get(id)?.id).toBe(id);
  });

  it('R-11 clearForTest() leaves registry empty + reusable', () => {
    const r = new LintRuleRegistry();
    r.register(rule('a'));
    r.register(rule('b'));
    r.clearForTest();
    expect(r.size()).toBe(0);
    r.register(rule('a')); // re-registering after clear is allowed
    expect(r.size()).toBe(1);
  });

  it('R-12 dup rejection happens BEFORE the failed rule joins the registry', () => {
    const r = new LintRuleRegistry();
    r.register(rule('a'));
    try {
      r.register(rule('a'));
    } catch {
      /* ignore */
    }
    expect(r.size()).toBe(1);
    expect(r.list().length).toBe(1);
  });
});
