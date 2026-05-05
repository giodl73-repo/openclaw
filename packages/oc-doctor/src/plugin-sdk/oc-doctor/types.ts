/**
 * `@openclaw/oc-doctor` SDK types.
 *
 * **Strategic frame**: NO new SDK verb. We wrap an OcPath-aware fixer
 * into upstream's existing `registerDoctorHealthContribution` slot at
 * `src/flows/doctor-health.ts`. The adapter helper is the only new
 * public surface.
 *
 * **One fixer shape across all kinds**. Fixers consume the universal
 * `OcAst` and use `resolveOcPath` / `setOcPath` to inspect + mutate.
 * Kind-bound fixers narrow on `ast.kind` inside `detect()` /
 * `fix()` — TypeScript's discriminator narrowing is ergonomic.
 *
 * @module @openclaw/oc-doctor
 */

import type { OcAst, OcPath, OcPathMatch } from '@openclaw/oc-path';

/**
 * A file the doctor flow has loaded — universal shape regardless of
 * kind. Filename + path + raw bytes + parsed AST.
 */
export interface DoctorFile {
  readonly name: string;
  readonly path: string;
  readonly raw: string;
  readonly ast: OcAst;
}

/**
 * One mutation event emitted by the doctor adapter just before
 * `writeFile`. Audit-only — payload is small and bounded so log
 * pipelines (LKG-git, fsevents, observability) can record it cheaply.
 */
export interface DoctorMutationEvent {
  readonly contributionId: string;
  readonly fileName: string;
  readonly filePath: string;
  /** Bytes count of the file BEFORE the fix is applied. */
  readonly beforeBytes: number;
  /** Bytes count of the file AFTER the fix. */
  readonly afterBytes: number;
  /** Concrete `oc://` path the fix targeted (formatted from the match). */
  readonly ocPath: string;
  /** ISO-8601 timestamp the adapter recorded just before write. */
  readonly at: string;
}

/**
 * Context passed to detect/fix.
 */
export interface DoctorContext {
  readonly workspaceDir: string;
  readonly files: readonly DoctorFile[];
  /**
   * Per-fixer-id options that override the fixer's defaults. Adapter
   * merges this over `spec.defaultOptions` before calling fix.
   */
  readonly fixerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * If present, ONLY fixers whose `tier` falls in this set run.
   * Default behavior (when `enabledTiers` is undefined): all tiers
   * run — preserves existing host integrations that don't specify.
   *
   * Hosts use this to expose tier-graduated fix flags to operators
   * (`--fix` enables additive only; `--fix-mutating` adds mutating;
   * `--fix-regenerative` adds the rest). The contract surface is
   * the same — only the gate moves.
   */
  readonly enabledTiers?: ReadonlySet<FixerTier>;
  /**
   * Optional cancellation signal. Adapter checks `signal.aborted`
   * between files in `detect()` and bails out of `fix()` before the
   * file write if aborted. Host-supplied; tests can omit.
   */
  readonly signal?: AbortSignal;
  /**
   * Runtime kill switch — fixer contributionIds in this set are
   * skipped at the adapter boundary (detect returns no findings,
   * fix returns `{outcome: 'skipped', reason: 'disabled'}`). Lets
   * operators silence a fixer without unregistering it; useful for
   * per-CI-pipeline opt-out or per-PR exception.
   */
  readonly disabledContributionIds?: ReadonlySet<string> | readonly string[];
  /**
   * Optional audit hook. Fires once per successful mutation, just
   * BEFORE `writeFile` runs (so the host can log intent even if the
   * write subsequently fails). Errors thrown by `onMutation` are
   * swallowed by the adapter — audit MUST NOT fail the fix.
   *
   * Use cases: LKG-git observation, fsevents emission, sentinel-tail
   * observability, replay logs.
   */
  onMutation?(event: DoctorMutationEvent): void | Promise<void>;
  /**
   * Host-supplied async writer. Tests + non-FS hosts can stub this
   * without filesystem access. The host is responsible for atomic
   * rename / sentinel-guard / LKG observe semantics around the write.
   */
  writeFile(path: string, contents: string): Promise<void>;
}

/**
 * A finding produced by `detect()`.
 *
 * `match` is the typed result the `detect()` produced — `path: OcPath`
 * (concrete address) plus `match: OcMatch` (kind / line / leafType /
 * descriptor). `ocPath` and `line` are convenience pulls for display
 * consumers; the typed `match` is what `fix()` receives.
 */
export interface DoctorFinding {
  readonly contributionId: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly fileName: string;
  readonly filePath: string;
  readonly message: string;
  /** Convenience string form of `match.path` (formatOcPath result). */
  readonly ocPath: string;
  /** Convenience pull of `match.match.line`. */
  readonly line: number;
  /** Typed match — passed to `fix()` so it doesn't need to re-resolve. */
  readonly match: OcPathMatch;
  readonly fixHint?: string;
}

export type DoctorFixResult =
  | { readonly outcome: 'fixed'; readonly path: string }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string };

/**
 * The contract that upstream `registerDoctorHealthContribution`
 * accepts — this PR does NOT introduce a new SDK verb. The doctor
 * adapter (`ocPathFixerContribution`) wraps an `OcPathFixerSpec`
 * into this shape so it slots into the host's existing registration
 * call:
 *
 *   api.registerDoctorHealthContribution(ocPathFixerContribution(spec));
 *
 * The contract surface is intentionally narrow: a stable id, a
 * human-readable description, and the two async verbs the host
 * runner invokes. Everything else (typed match handoff, options
 * merge, sentinel guard, audit hook, abort signal) lives inside the
 * adapter — invisible to the host but available to the spec.
 *
 * **Why this shape, not a richer one**: the upstream `doctor` flow
 * already iterates contributions and calls `detect` + `fix` per
 * file. Wrapping that contract preserves the host's mental model
 * (one contribution = one health check) and keeps the universal-AST
 * machinery as an opt-in adapter rather than a new orthogonal SDK
 * verb. Plugin authors who don't need OcPath addressing can still
 * implement `DoctorHealthContribution` directly.
 *
 * The fields here mirror the upstream contract verbatim. If upstream
 * extends `DoctorHealthContribution` (e.g., adds a `priority` field
 * or a `requires` SDK-version gate), the matching field lands here
 * too and the adapter passes it through.
 */
export interface DoctorHealthContribution {
  /** Stable contribution id. Surfaces in audit logs and the doctor flow's CLI output. */
  readonly id: string;
  /** Human-readable description shown in `openclaw doctor` output. */
  readonly description: string;
  /**
   * Inspect the workspace; return zero or more findings. The host
   * collects findings across contributions before invoking any fix.
   * Findings are pure data (no host-mutation side effects).
   */
  detect(ctx: DoctorContext): Promise<readonly DoctorFinding[]>;
  /**
   * Resolve a single finding. The host invokes once per finding (the
   * fan-out semantic). Returns a structured outcome so the host's
   * CLI can summarize without parsing free-form messages.
   */
  fix(ctx: DoctorContext, finding: DoctorFinding): Promise<DoctorFixResult>;
}

// ---------- OcPath fixer spec (the input to the adapter) ------------------

/**
 * Default options for fixers that don't declare their own.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type DefaultFixerOptions = Record<string, never>;

/**
 * Risk classification for a fixer's mutation. Surfaces in
 * `OcPathFixerSpec.tier` and `DoctorContext.enabledTiers`. Each tier
 * is a strict superset of the previous one — `additive` is the
 * always-safe baseline; `mutating` includes anything that replaces
 * or rewrites existing content (still well-defined and reversible
 * via LKG); `regenerative` includes anything that fully rewrites
 * a security-sensitive artifact (e.g., regenerating `policy.jsonc`
 * from sources, which can produce a fail-closed policy on a wrong
 * regen).
 *
 *   `additive`     — adds missing structure; never deletes or replaces.
 *                    Examples: stub-section append, default-value insert.
 *                    Safe to run unattended.
 *
 *   `mutating`     — replaces or rewrites existing content. Still
 *                    well-defined; LKG preserves the prior version.
 *                    Examples: secret-literal redaction, key rename,
 *                    BOM strip. Should run with operator awareness
 *                    but not necessarily per-invocation confirmation.
 *
 *   `regenerative` — fully regenerates a security-sensitive artifact.
 *                    Wrong regen → fail-closed deny / lockout.
 *                    Example: policy/regenerate-on-drift. Should
 *                    require explicit per-invocation opt-in.
 */
export type FixerTier = 'additive' | 'mutating' | 'regenerative';

/**
 * What a plugin author writes to introduce a new OcPath-aware fixer.
 * Adapter wraps this into a `DoctorHealthContribution`.
 *
 * **Idempotency contract**: `fix()` MUST be idempotent. Running fix
 * twice produces the same bytes as running it once.
 *
 * **Additive-by-default**: starter fixers should ADD missing
 * structure rather than DELETE existing content. Destructive fixes
 * require explicit user confirmation.
 *
 * **Universal AST**: detect/fix consume `OcAst`. Use `resolveOcPath`
 * / `setOcPath` from the substrate. For kind-specific traversal,
 * narrow on `ast.kind`.
 */
export interface OcPathFixerSpec<TOptions = DefaultFixerOptions> {
  /** Stable id, prefixed with the fixer pack namespace. */
  readonly id: string;
  /** Human-readable description (surfaces in `openclaw doctor`). */
  readonly description: string;
  /** Severity carried into the `DoctorFinding`. */
  readonly severity: 'info' | 'warning' | 'error';
  /**
   * Filename glob (`*.jsonc`, `gateway.*`) or exact filename
   * (`AGENTS.md`) or `'*'`.
   */
  readonly appliesTo: string;
  /**
   * Risk-tier classification (see `FixerTier`). Defaults to `'mutating'`
   * if unset — the most common case. Hosts gate `--fix` behavior by
   * tier; the contract field lets the gate be deterministic per-fixer
   * rather than guessed from the description.
   */
  readonly tier?: FixerTier;
  /** Default options applied when caller doesn't override at invocation. */
  readonly defaultOptions?: TOptions;
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
   * `'speculative'` means best-guess design — the fixer may be culled
   * outright in a future minor version if it doesn't earn its keep.
   */
  readonly status?: 'stable' | 'speculative';
  /**
   * Inspect an AST + raw bytes; for each issue, return a typed
   * `OcPathMatch` (path + match-with-line/leafType) along with a
   * human-readable message and optional fix hint.
   *
   * Empty result = no fix needed. Each entry becomes one
   * `DoctorFinding` and one `fix()` invocation.
   *
   * **Cross-file fixers**: `siblingFiles` carries the rest of the
   * workspace alongside the file being inspected. Most fixers
   * ignore it; multi-file fixers (e.g., a policy.jsonc-vs-sources
   * drift check) read it to compute findings that depend on related
   * files. The fixer's own `appliesTo` glob still narrows which
   * file `ast/raw` is bound to — sibling access is additive, not
   * a replacement for the per-file dispatch.
   */
  detect(input: {
    fileName: string;
    ast: OcAst;
    raw: string;
    /**
     * Same merged options the adapter passes to `fix()` — `defaultOptions`
     * overlaid with any caller override from `ctx.fixerOptions[spec.id]`.
     * Optional; detect implementations that don't need options can
     * ignore. Symmetry with `fix()` lets a rule's allowed-value set
     * (e.g., scopes, tiers) be operator-overridable at detect time
     * too, not just at fix time.
     */
    options?: TOptions;
    /**
     * Read-only access to other files in the workspace. Single-file
     * fixers ignore this; cross-file fixers (e.g., policy drift)
     * use it to compute findings that depend on sibling state.
     * The current file is excluded from this list.
     */
    siblingFiles?: readonly DoctorFile[];
    /** Absolute workspace directory — useful for cross-file fixers writing to a non-current path. */
    workspaceDir?: string;
  }): readonly DoctorDetectResult[] | Promise<readonly DoctorDetectResult[]>;
  /**
   * Given the current bytes and the typed `OcPathMatch` produced by
   * `detect()`, produce new bytes that resolve the issue. MUST be
   * idempotent. The match carries the resolved path, the matched node
   * kind / leaf text / line — `fix()` doesn't need to re-resolve.
   *
   * `options` is `defaultOptions` merged with any caller override
   * supplied via `ctx.fixerOptions[spec.id]` — same value detect saw.
   *
   * **Fan-out semantic**: one `fix()` call per match. The runner
   * iterates over every detect result and invokes `fix()` once each.
   * Fixers MUST handle a single match — not the whole match list.
   *
   * **Cross-file fixers**: `siblingFiles` matches detect's surface.
   */
  fix(input: {
    fileName: string;
    ast: OcAst;
    raw: string;
    match: OcPathMatch;
    options?: TOptions;
    siblingFiles?: readonly DoctorFile[];
    workspaceDir?: string;
  }): string | Promise<string>;
}

/**
 * Output of `OcPathFixerSpec.detect()` — one entry per issue found.
 * Each entry carries the typed `OcPathMatch` (path + match) the
 * adapter packages into a `DoctorFinding`. `line` and `ocPath` on the
 * finding are derived from the match — fixers don't supply them
 * separately.
 */
export interface DoctorDetectResult {
  readonly match: OcPathMatch;
  readonly message: string;
  readonly fixHint?: string;
}

// Re-export OcPath for downstream type imports.
export type { OcPath };
