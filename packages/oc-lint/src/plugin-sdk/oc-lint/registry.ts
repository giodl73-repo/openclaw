/**
 * Lint rule registry — global runtime registry mirroring the
 * `policy-substrate/registry.ts` shape. Plugin authors register
 * rules at module-init time; the CLI and runners discover via
 * `listLintRules()`.
 *
 * **The plugin-shape pattern**: every openclaw plugin that ships
 * rules / fixers / trackers / generators uses the same shape:
 *   1. Define your spec (here: `LintRule`)
 *   2. Top-level `register*(spec)` call in your module
 *   3. Consumer imports your module → registration fires
 *   4. CLI / runner discovers via `list*()`
 *
 * This is what enables "policy is the canonical plugin pattern"
 * — same registration story across pinch, oc-doctor, lkg-recovery,
 * and policy-substrate.
 *
 * @module @openclaw/oc-lint/registry
 */

import type { LintRule } from './types.js';

const REGISTRY = new Map<string, LintRule<unknown>>();

/**
 * Register a lint rule. Call at module-init time so the CLI sees
 * the rule before dispatch. Re-registering the same id replaces
 * the previous spec (last-writer-wins; useful in tests and for
 * operator-controlled rule overrides).
 *
 *   import { registerLintRule } from '@openclaw/oc-lint';
 *   registerLintRule(myRule);
 */
export function registerLintRule<TOptions = unknown>(
  rule: LintRule<TOptions>,
): void {
  REGISTRY.set(rule.id, rule as LintRule<unknown>);
}

/**
 * Look up a registered rule by id. Returns `null` if not registered.
 */
export function getLintRule(id: string): LintRule<unknown> | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * Enumerate all registered rules. Used by the CLI's `pinch run`
 * subcommand and by hosts that want to surface available rules to
 * operators.
 */
export function listLintRules(): readonly LintRule<unknown>[] {
  return [...REGISTRY.values()];
}

/**
 * Test helper: clear the registry. Tests that need to register a
 * temporary rule can `_clearLintRuleRegistry()` in a `beforeEach`
 * to avoid cross-test pollution.
 */
export function _clearLintRuleRegistry(): void {
  REGISTRY.clear();
}
