/**
 * `oc-lint` runtime — registry + runner. Lives at
 * `openclaw-core/src/oc-lint/` upstream.
 *
 * @module oc-lint
 */

export { LintRuleRegistry } from './registry.js';
export type { LintFile, LintRunOptions, LintRunResult } from './runner.js';
export { LintAbortedError, runLint } from './runner.js';
