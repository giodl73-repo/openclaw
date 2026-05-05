/**
 * Rule: `policy-starter-v0/tools/unknown-risk-level`
 * Severity: warning
 * Applies to: TOOLS.md
 *
 * Flag: tool meta has an `R<n>` token where `n` is out of the
 * accepted range {0, 1, 2, 3, 4, 5}. Common typos: R6 / R7 (operator
 * thought the scale was R0..R10), R-1 (operator wanted "below low").
 * The extractor's regex `R[0-5]` doesn't match these — the tool
 * silently falls back to `low`. This rule surfaces the mismatch.
 *
 * Paired fixer (optional): `tools/snap-risk-level` snaps R6+ → R5
 * and negative → R0.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

export const toolsUnknownRiskLevel: LintRule = {
  id: 'policy-starter-v0/tools/unknown-risk-level',
  severity: 'warning',
  description:
    'TOOLS.md tool declares an out-of-range `R<n>` risk token (accepted: R0..R5)',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      // Match `R-?\d+` to catch R7, R-1, R12 etc.
      const m = /\bR(-?\d+)\b/.exec(hit.meta);
      if (m === null || m[1] === undefined) continue;
      const n = Number(m[1]);
      if (n >= 0 && n <= 5) continue;
      findings.push({
        message: `tool '${hit.name}' uses out-of-range risk 'R${n}'; accepted range is R0..R5`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: n > 5 ? 'snap to R5 (critical)' : 'snap to R0 (lowest)',
      });
    }
    return findings;
  },
};
