/**
 * Rule: `policy-starter-v0/tools/irreversible-low-risk-mismatch`
 * Severity: warning
 * Applies to: TOOLS.md
 *
 * Flag: tool has `IRREVERSIBLE_EXTERNAL` capability paired with
 * R0..R3 risk. Capability says "this can't be undone"; risk says
 * "casual." That's a security smell — guardrails route requires-
 * approval based on risk OR capability, but operators reading the
 * IR shouldn't have to reverse-engineer that the tool is actually
 * critical from its capabilities alone.
 *
 * Paired fixer: `tools/bump-risk-on-irreversible` raises R0..R3
 * to R4 (high). Doesn't push to R5 — true critical-vs-high is an
 * operator decision based on blast radius.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

export const toolsIrreversibleLowRiskMismatch: LintRule = {
  id: 'policy-starter-v0/tools/irreversible-low-risk-mismatch',
  severity: 'warning',
  description:
    'TOOLS.md tool has IRREVERSIBLE_EXTERNAL capability paired with R0..R3 risk',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      if (hit.meta === '') continue;
      if (!/\bIRREVERSIBLE_EXTERNAL\b/.test(hit.meta)) continue;
      const m = /\bR([0-3])\b/.exec(hit.meta);
      if (m === null) continue;
      findings.push({
        message: `tool '${hit.name}' is IRREVERSIBLE_EXTERNAL but declared R${m[1]}; security smell`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: 'bump to at least R4 (high) — IRREVERSIBLE_EXTERNAL implies non-trivial blast radius',
      });
    }
    return findings;
  },
};
