/**
 * Shared value-sets for the starter packs.
 *
 * Lint rules + doctor fixers under the `starter-v0` / `jsonl-starter-v0`
 * / `jsonc-starter-v0` / `yaml-starter-v0` namespaces share these
 * domain-knowledge constants. Drift between lint detection and fixer
 * action is a known footgun (a fixer that "snaps" a value the lint
 * doesn't actually flag, and vice versa); centralizing here makes
 * drift impossible — both sides import from one place.
 *
 * Convention: value-set CONSTANTS live here (token shapes, allowed
 * enumerations, terminal sentinels). Per-rule logic stays in the
 * rule/fixer files. If a rule and its paired fixer differ on what
 * counts as "invalid," that disagreement is a bug to fix HERE, not
 * a feature to express in two places.
 *
 * @module @openclaw/oc-lint/shared/starter-values
 */

/**
 * Token-shape regexes for `jsonc-starter-v0/config/secret-as-literal`
 * (lint) and `jsonc-starter-v0/config/redact-secret-literal` (fixer).
 *
 * Conservative — false positives are rare enough that an exception
 * annotation is cheaper than rotating a leaked token. Adding a new
 * shape here automatically opts both lint and fixer into detection.
 */
export interface TokenPattern {
  readonly label: string;
  readonly re: RegExp;
}

export const STARTER_TOKEN_PATTERNS: readonly TokenPattern[] = [
  { label: 'github-personal-token', re: /^ghp_[A-Za-z0-9]{36,}$/ },
  { label: 'github-fine-grained-pat', re: /^github_pat_[A-Za-z0-9_]{40,}$/ },
  { label: 'slack-token', re: /^xox[abp]-[A-Za-z0-9-]{10,}$/ },
  { label: 'openai-api-key', re: /^sk-[A-Za-z0-9]{32,}$/ },
  { label: 'aws-access-key', re: /^AKIA[0-9A-Z]{16}$/ },
  { label: 'hex-secret', re: /^[a-fA-F0-9]{40,}$/ },
];

/**
 * Terminal `event:` values for `jsonl-starter-v0/session/no-terminal-event`
 * (lint) and `jsonl-starter-v0/session/append-terminal-event` (fixer).
 *
 * A session log ending with one of these is considered cleanly
 * terminated; anything else means the session is still in flight or
 * the log was truncated.
 */
export const STARTER_TERMINAL_EVENT_VALUES: ReadonlySet<string> = new Set([
  'end',
  'complete',
  'finalized',
  'done',
]);

/**
 * In-process tool tokens for `lobster-yaml-starter-v0/step/shell-tool-collision`
 * (lint) and `yaml-starter-v0/step/swap-shell-to-pipeline` (fixer).
 *
 * A step whose `command:` / `run:` first token matches one of these
 * is wrong-by-construction: the dispatch should be `pipeline:` so the
 * runtime calls the in-process invoker rather than spawning a shell.
 */
export const STARTER_IN_PROCESS_TOOLS: readonly string[] = [
  'openclaw.invoke',
  'llm_task.invoke',
  'llm.invoke',
  'lobster',
];

/**
 * Allowed `scope:` values for `starter-v0/memory/invalid-scope-value`
 * (lint, when implemented) and `starter-v0/memory/snap-scope` (fixer).
 *
 * Operators can override via the fixer's `SnapScopeOptions.allowedScopes`,
 * but the default value-set lives here so lint + fixer agree on what
 * counts as "invalid."
 */
export const STARTER_ALLOWED_MEMORY_SCOPES: readonly string[] = [
  'default',
  'global',
  'project',
  'session',
];

/**
 * Allowed `tier:` values for `starter-v0/skill/invalid-tier-value`
 * (lint, when implemented) and `starter-v0/skill/snap-tier` (fixer).
 *
 * Operators can override via the fixer's `SnapTierOptions.allowedTiers`.
 */
export const STARTER_ALLOWED_SKILL_TIERS: readonly number[] = [1, 2, 3];
