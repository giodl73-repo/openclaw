/**
 * Lint rule registry — backs the host's `api.registerLintRule(rule)`
 * verb. Tracks registered rules by id; rejects duplicates.
 *
 * @module oc-lint/registry
 */

import type { LintRule } from '../plugin-sdk/oc-lint/types.js';
import { LintRuleRegistrationError } from '../plugin-sdk/oc-lint/api-extension.js';

/**
 * Mutable registry of registered lint rules. The host instantiates one
 * per gateway process (or per tenant in multi-tenant deployments).
 */
export class LintRuleRegistry {
  private readonly rules = new Map<string, LintRule>();

  /**
   * Register a rule. Throws `LintRuleRegistrationError` if a rule with
   * the same id is already registered.
   */
  register(rule: LintRule): void {
    if (this.rules.has(rule.id)) {
      throw new LintRuleRegistrationError(rule.id);
    }
    this.rules.set(rule.id, rule);
  }

  /**
   * Iterator over registered rules in insertion order. Callers can
   * filter by `appliesTo` themselves — the runner does this to dispatch
   * rules to the right files.
   */
  list(): readonly LintRule[] {
    return [...this.rules.values()];
  }

  /**
   * Look up a rule by id (returns `undefined` if not registered).
   * Used by the doctor adapter when wiring an OcPathFixer to its
   * companion lint rule.
   */
  get(id: string): LintRule | undefined {
    return this.rules.get(id);
  }

  /**
   * Number of registered rules. Used by tests + diagnostic readouts.
   */
  size(): number {
    return this.rules.size;
  }

  /**
   * Clear all registered rules. Test-only convenience; production
   * gateways instantiate a fresh registry per process.
   */
  clearForTest(): void {
    this.rules.clear();
  }
}
