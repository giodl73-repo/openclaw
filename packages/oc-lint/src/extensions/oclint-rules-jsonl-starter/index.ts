/**
 * `oclint-rules-jsonl-starter` — starter rule pack for jsonl session logs.
 *
 * Severity defaults: info for shape rules, warning for malformed-line
 * (because mid-stream corruption signals a writer or process problem
 * that operators should diagnose).
 *
 * @module oclint-rules-jsonl-starter
 */

import type { LintRule } from '../../plugin-sdk/oc-lint/types.js';
import { registerLintRule } from '../../plugin-sdk/oc-lint/registry.js';
import { sessionEmptyLog } from './rules/session-empty-log.js';
import { sessionMalformedLine } from './rules/session-malformed-line.js';
import { sessionMissingEventKey } from './rules/session-missing-event-key.js';
import { sessionNoTerminalEvent } from './rules/session-no-terminal-event.js';

export const jsonlStarterRules: readonly LintRule[] = [
  sessionEmptyLog,
  sessionMissingEventKey,
  sessionMalformedLine,
  sessionNoTerminalEvent,
];

// Self-register on import.
for (const rule of jsonlStarterRules) {
  registerLintRule(rule);
}

export {
  sessionEmptyLog,
  sessionMalformedLine,
  sessionMissingEventKey,
  sessionNoTerminalEvent,
};
