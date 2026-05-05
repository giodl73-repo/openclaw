/**
 * `@openclaw/oc-lint` SDK types — the surface plugins import.
 *
 * **Strategic frame**: opt-in lint rules over the universal `OcPath`
 * addressing scheme. Rules consume an `OcAst` (universal), use
 * `resolveOcPath` to inspect, and emit findings carrying `oc://` paths
 * so editors / doctor / fixers can deep-link to the offending location.
 *
 * **One rule shape across all kinds**. A rule that's intrinsically
 * kind-bound (e.g., session-malformed-line is meaningful only for
 * jsonl) narrows on `ast.kind` inside `check()` — TypeScript's
 * discriminator narrowing makes that ergonomic. The `appliesTo` glob
 * already filters which files feed the rule; the kind-narrow inside
 * `check()` is defense-in-depth + lets the rule access kind-specific
 * shapes after the narrow.
 *
 * @module @openclaw/oc-lint
 */

import type { OcAst } from '@openclaw/oc-path';

/**
 * Filenames are open across all kinds (md, jsonc, jsonl, yaml). Rules
 * filter via `appliesTo` glob — exact filename (`AGENTS.md`),
 * extension wildcard (`*.jsonc`), or brace alternation
 * (`{gateway,openclaw}*.jsonc`). The SDK doesn't impose a closed
 * vocabulary on filenames; lobster-specific or workspace-specific
 * conventions live in the rule packs themselves, not in the
 * universal SDK surface.
 */

/**
 * Diagnostic severity.
 *
 * **Convention** for upstream-shipped rule packs: start at `info`,
 * upgrade to `warning` only after community signal validates the rule
 * is high-leverage, upgrade to `error` only when the rule guards
 * against a known failure class. Operators can override per-rule
 * severity via host config.
 */
export type LintSeverity = 'info' | 'warning' | 'error';

/**
 * A diagnostic emitted by a lint rule. Carries the rule id, a stable
 * severity, a human-readable message, and an `oc://` path the editor /
 * doctor / fixer can use to navigate to the offending location.
 */
export interface Diagnostic {
  readonly ruleId: string;
  readonly severity: LintSeverity;
  /**
   * Filename of the linted artifact — open string across all kinds.
   * Rules use the `appliesTo` glob to filter what they fire on.
   */
  readonly fileName: string;
  readonly message: string;
  /**
   * Formatted `oc://` URI pointing at the offending node. Lint rules
   * SHOULD aim for the most specific path they can compute.
   */
  readonly ocPath: string;
  /** 1-based line number. */
  readonly line: number;
  /** Optional human-readable suggestion (e.g., "add a `tools:` list"). */
  readonly fixHint?: string;
}

/**
 * What a `check()` function returns. Same shape as `Diagnostic` minus
 * the `ruleId`/`severity`/`fileName` (which the runner attaches from
 * the rule definition + invocation context).
 */
export interface LintFinding {
  readonly message: string;
  readonly ocPath: string;
  readonly line: number;
  readonly fixHint?: string;
}

/**
 * Default options shape for rules that don't declare their own.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type DefaultRuleOptions = Record<string, never>;

/**
 * Context passed to `LintRule.check`. Pure data: filename + universal
 * AST + merged options. Rules use `resolveOcPath` from the substrate
 * to inspect; rules with kind-specific logic narrow on `ast.kind`
 * inside `check()`.
 *
 * `check()` MUST be a pure function: no I/O, no AST mutation, no
 * filesystem/network. The runner may invoke it many times per file;
 * deterministic output is required.
 */
export interface LintRuleContext<TOptions = DefaultRuleOptions> {
  readonly fileName: string;
  readonly ast: OcAst;
  /**
   * Effective options for this rule invocation: `defaultOptions`
   * overlaid with any caller override from
   * `LintRunOptions.ruleOptions[rule.id]`. Optional — rules without
   * configurable behavior can ignore.
   */
  readonly options?: TOptions;
}

/**
 * A lint rule. ONE shape across all kinds — rules consume `OcAst` and
 * inspect via `resolveOcPath`. Kind-bound rules narrow on `ast.kind`
 * inside `check()`.
 *
 * `TOptions` typed: rules with operator-overridable behavior declare
 * their option shape and `defaultOptions`. The runner merges
 * `defaultOptions` with `LintRunOptions.ruleOptions[rule.id]` and
 * passes the merged value via `ctx.options`.
 */
export interface LintRule<TOptions = DefaultRuleOptions> {
  /**
   * Stable rule identifier, prefixed with the rule pack namespace.
   * Convention: `<rule-pack>/<area>/<short-name>`. Examples:
   *   `starter-v0/agents/empty-tools-section`
   *   `jsonc-starter-v0/config/missing-plugins`
   */
  readonly id: string;

  /**
   * Default severity for diagnostics this rule produces. Operators can
   * override via host config (a future extension); the rule itself
   * declares its preferred severity.
   */
  readonly severity: LintSeverity;

  /**
   * Human-readable description of what the rule checks. Surfaces in
   * `openclaw doctor` output, editor tooltips, and audit records.
   */
  readonly description: string;

  /**
   * Which file(s) the rule applies to. Glob pattern (`*.jsonc`,
   * `gateway.*`) or exact filename (`AGENTS.md`) or `'*'` for all.
   * The runner skips rules whose `appliesTo` doesn't match.
   */
  readonly appliesTo: string;

  /**
   * SDK-version compatibility hint. Plugins authored against a known
   * SDK version declare it here; the registrar warns on mismatch with
   * the host's `SDK_VERSION`. Optional — omitting it means "trust the
   * host," which is the right default for in-tree starter packs.
   */
  readonly requires?: {
    readonly sdkVersion: string;
  };
  /**
   * Stability tag. `'stable'` (default) means community-validated and
   * subject to the usual deprecation process before removal.
   * `'speculative'` means best-guess design — the rule may be culled
   * outright in a future minor version if it doesn't earn its keep.
   * Surfaces in `openclaw lint --list` so operators can see which
   * rules are load-bearing vs in-evaluation.
   */
  readonly status?: 'stable' | 'speculative';

  /**
   * Default options applied when caller doesn't override at invocation
   * time via `LintRunOptions.ruleOptions[rule.id]`. Optional — rules
   * without configurable behavior omit this.
   */
  readonly defaultOptions?: TOptions;

  /**
   * Pure check function. Receives the universal AST + filename + merged
   * options; returns 0+ findings. Use `resolveOcPath` from the substrate
   * to inspect; narrow on `ctx.ast.kind` for kind-specific logic.
   */
  check(ctx: LintRuleContext<TOptions>): readonly LintFinding[];
}
