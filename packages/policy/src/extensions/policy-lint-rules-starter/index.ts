/**
 * `policy-lint-rules-starter` — lint rule pack for TOOLS.md authoring
 * pitfalls that policy cares about.
 *
 * **Strategic frame**: policy is the canonical plugin shape — it
 * ships its own lint rules + doctor fixers from inside the plugin's
 * own package. Operators who add `@openclaw/policy` to their
 * workspace and import `@openclaw/policy/lint-rules-starter`
 * automatically gain authoring guardrails for the TOOLS.md surface
 * the policy generator consumes.
 *
 * **Six rules** (all advisory-by-default; pair with doctor fixers
 * where auto-correction is safe):
 *   - `tools/legacy-sensitivity-syntax` (info) — paired
 *   - `tools/unknown-sensitivity-token` (warning) — advisory + optional snap
 *   - `tools/missing-risk-level` (warning) — paired
 *   - `tools/unknown-risk-level` (warning) — advisory + optional snap
 *   - `tools/irreversible-low-risk-mismatch` (warning) — paired
 *   - `tools/duplicate-tool-id` (warning) — advisory + optional dedupe
 *
 * Self-registers on import (matches pinch / oc-doctor pattern).
 *
 * @module @openclaw/policy/lint-rules-starter
 */

import type { LintRule } from '@openclaw/oc-lint/plugin-sdk';
import { registerLintRule } from '@openclaw/oc-lint/plugin-sdk';

import { toolsDuplicateToolId } from './rules/tools-duplicate-tool-id.js';
import { toolsIrreversibleLowRiskMismatch } from './rules/tools-irreversible-low-risk-mismatch.js';
import { toolsLegacySensitivitySyntax } from './rules/tools-legacy-sensitivity-syntax.js';
import { toolsMissingRiskLevel } from './rules/tools-missing-risk-level.js';
import { toolsUnknownRiskLevel } from './rules/tools-unknown-risk-level.js';
import { toolsUnknownSensitivityToken } from './rules/tools-unknown-sensitivity-token.js';

export const POLICY_STARTER_RULES_V0: readonly LintRule[] = [
  toolsLegacySensitivitySyntax,
  toolsUnknownSensitivityToken,
  toolsMissingRiskLevel,
  toolsUnknownRiskLevel,
  toolsIrreversibleLowRiskMismatch,
  toolsDuplicateToolId,
];

// Self-register on import.
for (const rule of POLICY_STARTER_RULES_V0) {
  registerLintRule(rule);
}

export {
  toolsDuplicateToolId,
  toolsIrreversibleLowRiskMismatch,
  toolsLegacySensitivitySyntax,
  toolsMissingRiskLevel,
  toolsUnknownRiskLevel,
  toolsUnknownSensitivityToken,
};
