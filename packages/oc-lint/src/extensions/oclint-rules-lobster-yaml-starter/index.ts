/**
 * `oclint-rules-lobster-yaml-starter` — lint rules for `.lobster`
 * workflow files (YAML kind).
 *
 * **Source**: rule pack derived from real user-filed issues at
 * openclaw/lobster. Each rule references the issue number that
 * surfaced it.
 *
 * **v0 ship list** (4 rules from the highest-leverage issues):
 *   - step/shell-tool-collision (#25, #26, #41) — error
 *   - step/mutually-exclusive-body (#41) — error
 *   - step/duplicate-id (#76, #77) — error
 *   - step/undefined-stdin-ref (#41) — error
 *
 * @module oclint-rules-lobster-yaml-starter
 */

import type { LintRule } from '../../plugin-sdk/oc-lint/types.js';
import { registerLintRule } from '../../plugin-sdk/oc-lint/registry.js';
import { stepDuplicateId } from './rules/step-duplicate-id.js';
import { stepMutuallyExclusiveBody } from './rules/step-mutually-exclusive-body.js';
import { stepShellToolCollision } from './rules/step-shell-tool-collision.js';
import { stepUndefinedStdinRef } from './rules/step-undefined-stdin-ref.js';

export const lobsterYamlStarterRules: readonly LintRule[] = [
  stepShellToolCollision,
  stepMutuallyExclusiveBody,
  stepDuplicateId,
  stepUndefinedStdinRef,
];

// Self-register on import.
for (const rule of lobsterYamlStarterRules) {
  registerLintRule(rule);
}

export {
  stepDuplicateId,
  stepMutuallyExclusiveBody,
  stepShellToolCollision,
  stepUndefinedStdinRef,
};
