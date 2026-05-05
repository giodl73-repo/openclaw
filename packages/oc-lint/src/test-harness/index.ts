/**
 * Test harness for plugin authors.
 *
 * Minimal helpers to exercise a single `LintRule` against an in-memory
 * file without setting up the full runner. Plugin packs use these in
 * their own test suites so they don't have to reinvent fixture
 * scaffolding (filename → kind dispatch → AST → ctx).
 *
 *   import { runRule, assertFlags } from '@openclaw/oc-lint/test-harness';
 *
 *   const findings = runRule(myRule, 'AGENTS.md', '## H\n');
 *   assertFlags(findings, 'my-pack/agents/foo');
 *
 * Convenience surface — production code should use `runLint` from the
 * oc-lint runtime.
 *
 * @module @openclaw/oc-lint/test-harness
 */

import {
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
} from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../plugin-sdk/oc-lint/types.js';

/**
 * Parse `raw` per filename heuristic and return the universal AST.
 * Kind dispatch matches the substrate's `inferKind`. Tests that need
 * to override the kind (e.g., `.txt` file with jsonc content) can
 * pass an `ast` directly via `runRuleWithAst`.
 */
export function parseForLint(fileName: string, raw: string): OcAst {
  const kind = inferKind(fileName);
  if (kind === 'jsonc') return parseJsonc(raw).ast;
  if (kind === 'jsonl') return parseJsonl(raw).ast;
  if (kind === 'yaml') return parseYaml(raw).ast;
  return parseMd(raw).ast;
}

/**
 * Run a single rule against a single in-memory file. Returns findings
 * exactly as the rule produced them (no severity overlay, no
 * runner-attached fields).
 */
export function runRule<TOptions = unknown>(
  rule: LintRule<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): readonly LintFinding[] {
  const ast = parseForLint(fileName, raw);
  return rule.check({
    fileName,
    ast,
    ...(options !== undefined ? { options } : {}),
  });
}

/**
 * Variant for callers that already have a parsed AST (e.g., reusing a
 * fixture-loaded one across multiple rule invocations).
 */
export function runRuleWithAst<TOptions = unknown>(
  rule: LintRule<TOptions>,
  fileName: string,
  ast: OcAst,
  options?: TOptions,
): readonly LintFinding[] {
  return rule.check({
    fileName,
    ast,
    ...(options !== undefined ? { options } : {}),
  });
}

/**
 * Assert that a findings list contains at least one entry whose
 * `ocPath` matches the given path (or any entry if `ocPath` is
 * omitted). Throws an `Error` on mismatch — vitest / jest / node:test
 * surface it as a test failure.
 */
export function assertFlags(
  findings: readonly LintFinding[],
  ruleId: string,
  ocPath?: string,
): void {
  if (findings.length === 0) {
    throw new Error(`expected rule ${ruleId} to flag, got 0 findings`);
  }
  if (ocPath !== undefined && !findings.some((f) => f.ocPath === ocPath)) {
    const got = findings.map((f) => f.ocPath).join(', ');
    throw new Error(`expected rule ${ruleId} to flag at ${ocPath}, got: ${got}`);
  }
}

/**
 * Assert that a findings list is empty. Throws an `Error` if any
 * findings are present, including the list in the message for fast
 * triage.
 */
export function assertNoFlags(
  findings: readonly LintFinding[],
  ruleId: string,
): void {
  if (findings.length > 0) {
    const summary = findings.map((f) => `${f.ocPath}: ${f.message}`).join('; ');
    throw new Error(`expected rule ${ruleId} not to flag; got: ${summary}`);
  }
}
