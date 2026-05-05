import { describe, expect, it } from 'vitest';
import { LintRuleRegistrationError } from '../../../src/plugin-sdk/oc-lint/index.js';

describe('SDK types', () => {
  it('LintRuleRegistrationError carries the rule id + stable code', () => {
    const e = new LintRuleRegistrationError('foo/bar');
    expect(e.code).toBe('OC_LINT_DUPLICATE_RULE');
    expect(e.ruleId).toBe('foo/bar');
    expect(e.message).toContain('foo/bar');
    expect(e.name).toBe('LintRuleRegistrationError');
  });
});
