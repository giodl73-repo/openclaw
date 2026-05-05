/**
 * `ocPathFixerContribution` — adapter that wraps an `OcPathFixerSpec`
 * into a `DoctorHealthContribution` ready for upstream's existing
 * `registerDoctorHealthContribution` slot.
 *
 * **No new SDK verb.** Plugins call:
 *
 *   api.registerDoctorHealthContribution(ocPathFixerContribution(spec))
 *
 * The contribution walks `ctx.files` (universal — all kinds), filters
 * by `appliesTo` glob, and dispatches to the spec's detect/fix. The
 * spec consumes `OcAst` and uses `resolveOcPath` / `setOcPath` from
 * the substrate; kind dispatch is implicit via `ast.kind`.
 *
 * @module @openclaw/oc-doctor/adapter
 */

import { REDACTED_SENTINEL, formatOcPath } from '@openclaw/oc-path';
import type {
  DoctorContext,
  DoctorFinding,
  DoctorFixResult,
  DoctorHealthContribution,
  OcPathFixerSpec,
} from './types.js';

/**
 * Filename glob with `*` (any chars) and `{a,b,c}` (alternation)
 * support. Mirrors the lint runner's matcher.
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

/**
 * Check whether a contribution id is disabled via the host's
 * `DoctorContext.disabledContributionIds`. Normalizes both array and
 * Set forms.
 */
function isDisabled(ctx: DoctorContext, id: string): boolean {
  const d = ctx.disabledContributionIds;
  if (d === undefined) return false;
  if (Array.isArray(d)) return d.includes(id);
  return (d as ReadonlySet<string>).has(id);
}

/**
 * Check whether a fixer's tier is enabled via the host's
 * `DoctorContext.enabledTiers` gate. Default (gate undefined) is
 * "all tiers enabled" — preserves backwards compat with hosts that
 * predate the tier classification.
 */
function isTierEnabled(
  ctx: DoctorContext,
  tier: 'additive' | 'mutating' | 'regenerative',
): boolean {
  if (ctx.enabledTiers === undefined) return true;
  return ctx.enabledTiers.has(tier);
}

/**
 * Compare a plugin-declared SDK version against the host's version.
 * Major mismatch is a hard incompatibility; minor/patch is fine
 * (additive changes by semver convention).
 *
 * Returns `null` if compatible, or a human-readable warning string
 * if not. The host decides whether to refuse or merely log.
 */
export function checkSdkCompat(
  hostVersion: string,
  pluginRequires: string,
): string | null {
  const hostMajor = hostVersion.split('.')[0];
  const pluginMajor = pluginRequires.split('.')[0];
  if (hostMajor !== pluginMajor) {
    return `SDK major version mismatch: host=${hostVersion}, plugin requires=${pluginRequires}`;
  }
  return null;
}

/**
 * Merge `spec.defaultOptions` with `ctx.fixerOptions[id]` (if present).
 * Caller-supplied options win on conflict.
 */
function resolveOptions<T>(
  defaultOptions: T | undefined,
  override: Record<string, unknown> | undefined,
): T {
  if (override === undefined) return (defaultOptions ?? {}) as T;
  return { ...(defaultOptions ?? {}), ...override } as T;
}

/**
 * Wrap an OcPath fixer spec into a doctor contribution.
 *
 *   const contribution = ocPathFixerContribution({
 *     id: 'pack/file/short-name',
 *     description: '...',
 *     severity: 'info',
 *     appliesTo: 'AGENTS.md',  // or '*.jsonc', '*.jsonl'
 *     detect({ ast, fileName }) { ... use resolveOcPath ... },
 *     fix({ ast, raw, match, options }) { ... use setOcPath ... },
 *   });
 *
 *   api.registerDoctorHealthContribution(contribution);
 */
export function ocPathFixerContribution<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
): DoctorHealthContribution {
  return {
    id: spec.id,
    description: spec.description,

    async detect(ctx: DoctorContext): Promise<readonly DoctorFinding[]> {
      if (isDisabled(ctx, spec.id)) return [];
      // Tier defaults to 'mutating' if unset — the most common case;
      // additive fixers explicitly declare 'additive' and regenerative
      // fixers explicitly declare 'regenerative'. Hosts that don't
      // gate by tier (`enabledTiers` undefined) see all fixers.
      const tier = spec.tier ?? 'mutating';
      if (!isTierEnabled(ctx, tier)) return [];
      const options = resolveOptions(spec.defaultOptions, ctx.fixerOptions?.[spec.id]);
      const findings: DoctorFinding[] = [];
      for (const f of ctx.files) {
        if (ctx.signal?.aborted) return findings;
        if (!matchGlob(spec.appliesTo, f.name)) continue;
        const siblingFiles = ctx.files.filter((other) => other.path !== f.path);
        const detected = await spec.detect({
          fileName: f.name,
          ast: f.ast,
          raw: f.raw,
          options,
          siblingFiles,
          workspaceDir: ctx.workspaceDir,
        });
        for (const d of detected) {
          findings.push({
            contributionId: spec.id,
            severity: spec.severity,
            fileName: f.name,
            filePath: f.path,
            message: d.message,
            // Derived from the typed match — single source of truth.
            ocPath: formatOcPath(d.match.path),
            line: d.match.match.line,
            match: d.match,
            ...(d.fixHint !== undefined ? { fixHint: d.fixHint } : {}),
          });
        }
      }
      return findings;
    },

    async fix(
      ctx: DoctorContext,
      finding: DoctorFinding,
    ): Promise<DoctorFixResult> {
      if (isDisabled(ctx, spec.id)) {
        return { outcome: 'skipped', reason: 'fixer is disabled via DoctorContext.disabledContributionIds' };
      }
      const tier = spec.tier ?? 'mutating';
      if (!isTierEnabled(ctx, tier)) {
        return { outcome: 'skipped', reason: `fixer tier '${tier}' not in enabledTiers` };
      }
      if (ctx.signal?.aborted) {
        return { outcome: 'failed', reason: 'aborted via signal' };
      }
      const file = ctx.files.find((f) => f.path === finding.filePath);
      if (file === undefined) {
        return { outcome: 'failed', reason: 'file not in DoctorContext' };
      }
      if (!matchGlob(spec.appliesTo, file.name)) {
        return { outcome: 'skipped', reason: 'fixer does not apply to this file' };
      }
      const options = resolveOptions(spec.defaultOptions, ctx.fixerOptions?.[spec.id]);
      const siblingFiles = ctx.files.filter((other) => other.path !== file.path);
      const after = await spec.fix({
        fileName: file.name,
        ast: file.ast,
        raw: file.raw,
        match: finding.match,
        options,
        siblingFiles,
        workspaceDir: ctx.workspaceDir,
      });
      if (after === file.raw) {
        return { outcome: 'skipped', reason: 'fix is a no-op (already correct)' };
      }
      // Belt-and-suspenders sentinel guard at the adapter boundary.
      // Substrate emitters already guard at every leaf, but fixers
      // that return raw bytes (string concat, regex replace) bypass
      // that path. Failing the fix here is fail-closed — the host
      // writer never sees `__OPENCLAW_REDACTED__` bytes.
      if (after.includes(REDACTED_SENTINEL)) {
        return {
          outcome: 'failed',
          reason: `fix output contains redaction sentinel — refusing to write to ${file.path}`,
        };
      }
      // Last chance to abort before the write — once writeFile starts,
      // we let the host's writer decide how to handle abort (atomic
      // rename, etc.).
      if (ctx.signal?.aborted) {
        return { outcome: 'failed', reason: 'aborted via signal' };
      }
      // Audit hook fires BEFORE write so the host records intent even
      // if the write fails. Errors in onMutation are swallowed —
      // audit MUST NOT fail the fix.
      if (ctx.onMutation !== undefined) {
        try {
          await ctx.onMutation({
            contributionId: spec.id,
            fileName: file.name,
            filePath: file.path,
            beforeBytes: file.raw.length,
            afterBytes: after.length,
            ocPath: formatOcPath(finding.match.path),
            at: new Date().toISOString(),
          });
        } catch {
          // Audit failures are non-fatal.
        }
      }
      try {
        await ctx.writeFile(file.path, after);
      } catch (err) {
        return {
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      return { outcome: 'fixed', path: file.path };
    },
  };
}
