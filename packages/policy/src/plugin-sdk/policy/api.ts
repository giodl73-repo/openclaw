/**
 * `@openclaw/plugin-sdk/policy/api` — extractor framework + runner.
 *
 * Mirrors the shape of oc-doctor's `OcPathFixerSpec` (minus the fix
 * step) — policy is the third consumer of the oc-paths universal
 * verbs, parallel to lint and doctor. Each policy concept (tool,
 * deny rule, capability, etc.) becomes a `PolicyExtractorSpec`
 * whose `extract()` runs `findOcPaths` against the parsed AST.
 *
 * The `runExtractors` helper composes a list of specs over a list
 * of files and returns a flat `ExtractorResult[]` ready for the
 * caller to compose into a `PolicyIR`. Pure function, no I/O.
 *
 * @module @openclaw/plugin-sdk/policy/api
 */

import type { OcAst } from '@openclaw/oc-path';

/**
 * Stable SDK version. Plugins authored against a known SDK declare
 * this in `requires.sdkVersion`; the host warns on major mismatch.
 */
export const SDK_VERSION = '0.1.0';

/**
 * One file the runner has been handed: name + path + raw + parsed
 * universal AST. Same shape as oc-lint's `LintFile` / oc-doctor's
 * `DoctorFile` so a single host walk feeds all three consumers.
 */
export interface PolicyExtractFile {
  /** Filename basename (used for `appliesTo` matching). */
  readonly name: string;
  /** Absolute filesystem path; used in `SourceLocation` stamps. */
  readonly path: string;
  /** Workspace-relative path (forward slashes); used for `oc://` URIs. */
  readonly relPath: string;
  readonly raw: string;
  readonly ast: OcAst;
}

/**
 * Context handed to a spec's `extract()`. Carries one file at a
 * time; the runner iterates, dispatching by `appliesTo` glob.
 */
export interface PolicyExtractorContext {
  readonly file: PolicyExtractFile;
}

/**
 * The shape every concept-extractor follows. `T` is the typed
 * concept the spec produces (e.g., `ToolSpec`, `DenyRule`).
 *
 * Mirrors the doctor `OcPathFixerSpec` precedent. Pure function;
 * no I/O, no AST mutation.
 */
export interface PolicyExtractorSpec<T> {
  /** Stable id; use `<concept>/<source>` form. */
  readonly id: string;
  readonly description: string;
  /**
   * Glob over filename. Same matcher as oc-lint / oc-doctor:
   * `'AGENTS.md'`, `'TOOLS.md'`, `'*.jsonc'`,
   * `'{session,audit,events}*.jsonl'`. `'*'` matches every file.
   */
  readonly appliesTo: string;
  /**
   * SDK-version compatibility hint. Plugins authored against a
   * known SDK declare it here; the host warns on major mismatch.
   * Optional — omitting it means "trust the host."
   */
  readonly requires?: {
    readonly sdkVersion: string;
  };
  /**
   * Extract typed concepts from the parsed AST. Output ordering is
   * deterministic across calls.
   */
  extract(ctx: PolicyExtractorContext): readonly T[];
}

/**
 * One concept the runner has aggregated from a single file. Stamped
 * with the originating spec's `id` so callers can attribute each
 * concept back to its declaration.
 */
export interface ExtractorResult<T> {
  readonly fromSpecId: string;
  readonly fromFile: string;
  readonly value: T;
}

export interface RunExtractorsOptions<T> {
  readonly specs: ReadonlyArray<PolicyExtractorSpec<T>>;
  readonly files: ReadonlyArray<PolicyExtractFile>;
  /**
   * Optional cancellation signal. The runner checks `signal.aborted`
   * between files and between specs. On abort returns the partial
   * results collected so far rather than throwing — matches the
   * shape used by oc-lint / oc-doctor runners.
   */
  readonly signal?: AbortSignal;
}

/**
 * Run all specs against all files. Specs whose `appliesTo` doesn't
 * match a file are skipped for that file. A spec that throws is
 * the spec author's bug — surfaced by attaching the exception to
 * the diagnostics list (TODO when diagnostics surface is added),
 * does NOT abort the run.
 *
 * Output ordering is deterministic: outer loop = files in input
 * order; inner loop = specs in input order; per-spec values
 * preserve the order returned by `extract()`.
 */
export function runExtractors<T>(
  opts: RunExtractorsOptions<T>,
): readonly ExtractorResult<T>[] {
  const out: ExtractorResult<T>[] = [];
  for (const file of opts.files) {
    if (opts.signal?.aborted) return out;
    for (const spec of opts.specs) {
      if (opts.signal?.aborted) return out;
      if (!matchGlob(spec.appliesTo, file.name)) continue;
      let values: readonly T[];
      try {
        values = spec.extract({ file });
      } catch {
        continue;
      }
      for (const v of values) {
        out.push({ fromSpecId: spec.id, fromFile: file.relPath, value: v });
      }
    }
  }
  return out;
}

/**
 * Filename glob with `*` (any chars) and `{a,b,c}` (alternation).
 * Mirrors the lint and doctor runners' matcher exactly.
 */
function matchGlob(glob: string, name: string): boolean {
  if (glob === name || glob === '*') return true;
  let pattern = glob.replace(/[.+^$()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(/\{([^{}]+)\}/g, (_m, body: string) => {
    const alts = body.split(',').map((s) => s.trim());
    return `(?:${alts.join('|')})`;
  });
  pattern = pattern.replace(/\*/g, '.*');
  const re = new RegExp('^' + pattern + '$');
  return re.test(name);
}
