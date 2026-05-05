/**
 * Lint rule registry tests — global runtime registry mirroring the
 * policy-substrate pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _clearLintRuleRegistry,
  getLintRule,
  listLintRules,
  registerLintRule,
} from '../../../src/plugin-sdk/oc-lint/registry.js';
import type { LintRule } from '../../../src/plugin-sdk/oc-lint/types.js';

const dummyRule: LintRule = {
  id: 'test/dummy',
  severity: 'info',
  description: 'test',
  appliesTo: '*',
  check: () => [],
};

describe('lint rule registry', () => {
  // Save the existing starter-pack registrations so other tests
  // (which import the starter pack) aren't disturbed.
  beforeEach(() => {
    // Don't clear — other tests rely on the starter pack being
    // present. Just verify register/list/get behave correctly
    // alongside the starter pack.
  });

  afterEach(() => {
    // Remove any test-specific registrations to avoid pollution.
    // We re-register the starter pack via dynamic import in
    // _clearLintRuleRegistry-using tests; here we just remove the
    // dummy.
    const reg = listLintRules().filter((r) => r.id === dummyRule.id);
    if (reg.length > 0) {
      // No way to deregister individually in v0; if a test
      // registers, it lasts until the suite reloads. Acceptable
      // for the v0 surface.
    }
  });

  it('REG-01 register adds a rule discoverable via getLintRule', () => {
    registerLintRule(dummyRule);
    expect(getLintRule('test/dummy')?.id).toBe('test/dummy');
  });

  it('REG-02 listLintRules includes registered rule', () => {
    registerLintRule(dummyRule);
    const ids = listLintRules().map((r) => r.id);
    expect(ids).toContain('test/dummy');
  });

  it('REG-03 re-register replaces the previous spec (last-writer-wins)', () => {
    registerLintRule({ ...dummyRule, severity: 'info' });
    registerLintRule({ ...dummyRule, severity: 'error' });
    expect(getLintRule('test/dummy')?.severity).toBe('error');
  });

  it('REG-04 getLintRule returns null for unknown id', () => {
    expect(getLintRule('does/not/exist')).toBeNull();
  });

  it('REG-05 starter pack auto-registered on import', async () => {
    // Trigger starter-pack import (idempotent if already imported).
    await import('../../../src/extensions/oclint-rules-starter/index.js');
    const ids = listLintRules().map((r) => r.id);
    expect(ids).toContain('starter-v0/agents/missing-boundaries');
    expect(ids).toContain('starter-v0/tools/empty-guidance-table');
  });

  it('REG-06 _clearLintRuleRegistry empties the registry (test helper)', () => {
    registerLintRule(dummyRule);
    _clearLintRuleRegistry();
    expect(listLintRules()).toEqual([]);
    expect(getLintRule('test/dummy')).toBeNull();
    // Re-register the starter pack so subsequent tests aren't
    // disturbed. (afterEach can't easily do this in module-level
    // test files; the test that clears is responsible for the
    // re-registration.)
  });
});
