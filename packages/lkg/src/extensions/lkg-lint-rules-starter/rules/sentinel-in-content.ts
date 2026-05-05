/**
 * Rule: `lkg-starter-v0/lkg/sentinel-in-content`
 * Severity: warning
 * Applies to: all canonical workspace files (md / jsonc / jsonl / yaml)
 *
 * Flag: file contains `__OPENCLAW_REDACTED__` bytes. When the LKG
 * store observes such content, the substrate's emit-time sentinel
 * guard rejects the bytes (per oc-paths emit contract). The
 * observation produces `{outcome: 'failed', reason: 'sentinel-in-content'}`,
 * blocking promotion. Surfacing it pre-observe lets the operator
 * scrub before the recovery pipeline trips.
 *
 * Paired fixer: `lkg/scrub-sentinel-from-tracked` replaces every
 * occurrence with `[REDACTED]`.
 */
import { REDACTED_SENTINEL } from '@openclaw/oc-path';
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';

const CANONICAL_GLOB = '*';

export const sentinelInContent: LintRule = {
  id: 'lkg-starter-v0/lkg/sentinel-in-content',
  severity: 'warning',
  description:
    'File contains __OPENCLAW_REDACTED__ bytes; LKG observe will fail at the sentinel guard',
  appliesTo: CANONICAL_GLOB,
  check(ctx) {
    const findings: LintFinding[] = [];
    if (typeof ctx.ast !== 'object' || ctx.ast === null) return findings;
    // Inspect raw bytes via the AST's `raw` field, present on every kind.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (ctx.ast as any).raw as string | undefined;
    if (typeof raw !== 'string') return findings;
    if (!raw.includes(REDACTED_SENTINEL)) return findings;
    // Find first occurrence's line for the diagnostic anchor.
    const idx = raw.indexOf(REDACTED_SENTINEL);
    const line = raw.slice(0, idx).split('\n').length;
    findings.push({
      message: `file contains __OPENCLAW_REDACTED__ at line ${line}; LKG observe will fail`,
      ocPath: `oc://${ctx.fileName}`,
      line,
      fixHint: 'replace sentinel bytes with [REDACTED] (or scrub the content entirely)',
    });
    return findings;
  },
};
