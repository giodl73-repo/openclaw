/**
 * Rule: `policy-starter-v0/tools/missing-risk-level`
 * Severity: warning
 * Applies to: TOOLS.md
 *
 * Flag: tool meta-line has no `R<n>` token. The extractor silently
 * defaults to `low` — that's the worst-case default for a tool that
 * might be `critical`. Operators MUST declare the risk explicitly.
 *
 * Paired fixer: `tools/recommend-risk-from-caps` proposes a level
 * based on capabilities present.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

export const toolsMissingRiskLevel: LintRule = {
  id: 'policy-starter-v0/tools/missing-risk-level',
  severity: 'warning',
  description:
    'TOOLS.md tool has no `R<n>` risk token; extractor silently defaults to low',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      // Only flag tools that have a meta-line (otherwise the extractor
      // skips them entirely — separate concern).
      if (hit.meta === '') continue;
      if (/\bR[0-5]\b/.test(hit.meta)) continue;
      findings.push({
        message: `tool '${hit.name}' has no R<n> risk token; defaults to low`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: 'declare an explicit `R<n>` between R0 (lowest) and R5 (critical)',
      });
    }
    return findings;
  },
};
