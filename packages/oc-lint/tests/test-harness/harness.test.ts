/**
 * Smoke tests for the lint test harness — proves plugin authors can
 * exercise their rules with one-line helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  assertFlags,
  assertNoFlags,
  parseForLint,
  runRule,
  runRuleWithAst,
} from '../../src/test-harness/index.js';
import type { LintRule } from '../../src/plugin-sdk/oc-lint/types.js';

const flagAlways: LintRule = {
  id: 'demo/flag-always',
  severity: 'info',
  description: 'always returns one finding',
  appliesTo: '*',
  check: () => [
    { message: 'flag', ocPath: 'oc://X.md', line: 1 },
  ],
};

const flagNever: LintRule = {
  id: 'demo/flag-never',
  severity: 'info',
  description: 'always returns zero findings',
  appliesTo: '*',
  check: () => [],
};

describe('lint test-harness', () => {
  it('runRule parses md by extension and returns findings', () => {
    const findings = runRule(flagAlways, 'AGENTS.md', '## H\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ocPath).toBe('oc://X.md');
  });

  it('runRule parses jsonc by extension', () => {
    const findings = runRule(flagAlways, 'gateway.jsonc', '{}');
    expect(findings).toHaveLength(1);
  });

  it('runRule parses yaml by extension', () => {
    const findings = runRule(flagAlways, 'wf.lobster', 'steps: []\n');
    expect(findings).toHaveLength(1);
  });

  it('runRuleWithAst accepts a pre-parsed AST', () => {
    const ast = parseForLint('AGENTS.md', '## H\n');
    expect(runRuleWithAst(flagAlways, 'AGENTS.md', ast)).toHaveLength(1);
  });

  it('assertFlags passes when findings exist', () => {
    const findings = runRule(flagAlways, 'AGENTS.md', '## H\n');
    expect(() => assertFlags(findings, 'demo/flag-always')).not.toThrow();
  });

  it('assertFlags throws when no findings', () => {
    const findings = runRule(flagNever, 'AGENTS.md', '## H\n');
    expect(() => assertFlags(findings, 'demo/flag-never')).toThrow(/expected/);
  });

  it('assertFlags with ocPath narrows the assertion', () => {
    const findings = runRule(flagAlways, 'AGENTS.md', '## H\n');
    expect(() => assertFlags(findings, 'demo/flag-always', 'oc://X.md')).not.toThrow();
    expect(() => assertFlags(findings, 'demo/flag-always', 'oc://OTHER.md')).toThrow(/at oc:/);
  });

  it('assertNoFlags passes when findings are empty', () => {
    const findings = runRule(flagNever, 'AGENTS.md', '## H\n');
    expect(() => assertNoFlags(findings, 'demo/flag-never')).not.toThrow();
  });

  it('assertNoFlags throws with a useful summary when findings exist', () => {
    const findings = runRule(flagAlways, 'AGENTS.md', '## H\n');
    expect(() => assertNoFlags(findings, 'demo/flag-always')).toThrow(/oc:\/\/X\.md/);
  });
});
