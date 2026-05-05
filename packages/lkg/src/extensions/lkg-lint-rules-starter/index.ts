/**
 * `lkg-lint-rules-starter` — lint rule pack for LKG-relevant
 * authoring pitfalls.
 *
 * **Strategic frame**: every substrate ships its own opinionated
 * rules. lkg's concerns are pre-observe failures
 * (sentinel guard, empty content, BOM) — flagged at lint time so
 * operators see them before the recovery pipeline trips. Mirrors
 * the pattern policy-substrate uses for TOOLS.md surface.
 *
 * **Three rules**:
 *   - `lkg/sentinel-in-content` (warning) — paired with scrub-sentinel
 *   - `lkg/empty-tracked-file` (info) — advisory; operator decides
 *   - `lkg/utf8-bom-in-content` (info) — paired with strip-utf8-bom
 *
 * Self-registers on import.
 *
 * @module @openclaw/lkg/lint-rules-starter
 */

import type { LintRule } from '@openclaw/oc-lint/plugin-sdk';
import { registerLintRule } from '@openclaw/oc-lint/plugin-sdk';

import { emptyTrackedFile } from './rules/empty-tracked-file.js';
import { sentinelInContent } from './rules/sentinel-in-content.js';
import { utf8BomInContent } from './rules/utf8-bom-in-content.js';

export const LKG_STARTER_RULES_V0: readonly LintRule[] = [
  sentinelInContent,
  emptyTrackedFile,
  utf8BomInContent,
];

// Self-register on import.
for (const rule of LKG_STARTER_RULES_V0) {
  registerLintRule(rule);
}

export {
  emptyTrackedFile,
  sentinelInContent,
  utf8BomInContent,
};
