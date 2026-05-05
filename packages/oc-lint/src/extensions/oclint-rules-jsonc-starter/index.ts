/**
 * `oclint-rules-jsonc-starter` — starter rule pack for jsonc config files.
 *
 * Severity defaults are conservative (info for shape rules, warning for
 * security-adjacent ones). Operators can override per-rule severity via
 * host config.
 *
 * @module oclint-rules-jsonc-starter
 */

import type { LintRule } from '../../plugin-sdk/oc-lint/types.js';
import { registerLintRule } from '../../plugin-sdk/oc-lint/registry.js';
import { configEmptyPluginsEntries } from './rules/config-empty-plugins-entries.js';
import { configMissingPlugins } from './rules/config-missing-plugins.js';
import { configMissingVersion } from './rules/config-missing-version.js';
import { configNoDuplicateTopLevelKeys } from './rules/config-no-duplicate-top-level-keys.js';
import { configSecretAsLiteral } from './rules/config-secret-as-literal.js';

export const jsoncStarterRules: readonly LintRule[] = [
  configMissingPlugins,
  configEmptyPluginsEntries,
  configMissingVersion,
  configSecretAsLiteral,
  configNoDuplicateTopLevelKeys,
];

// Self-register on import.
for (const rule of jsoncStarterRules) {
  registerLintRule(rule);
}

export {
  configEmptyPluginsEntries,
  configMissingPlugins,
  configMissingVersion,
  configNoDuplicateTopLevelKeys,
  configSecretAsLiteral,
};
