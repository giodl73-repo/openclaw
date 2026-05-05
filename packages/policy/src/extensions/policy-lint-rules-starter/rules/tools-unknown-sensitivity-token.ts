/**
 * Rule: `policy-starter-v0/tools/unknown-sensitivity-token`
 * Severity: warning
 * Applies to: TOOLS.md
 *
 * Flag: tool declares `sensitivity:<bogus>` where `<bogus>` is not in
 * the known set {public, internal, confidential, restricted}. The
 * extractor (POL-052) silently falls through to capability-derived
 * defaults; this rule surfaces the mismatch so operators don't
 * believe their tool is `bogus`-sensitive when it's actually
 * `internal` or `restricted` in the IR.
 *
 * Advisory-only: no auto-fix. Operators must decide which level
 * they meant.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

const KNOWN_LEVELS = ['public', 'internal', 'confidential', 'restricted'];

export const toolsUnknownSensitivityToken: LintRule = {
  id: 'policy-starter-v0/tools/unknown-sensitivity-token',
  severity: 'warning',
  description:
    'TOOLS.md tool declares `sensitivity:<bogus>` not in {public, internal, confidential, restricted}',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      const m = /\bsensitivity\s*:\s*(\w+)/i.exec(hit.meta);
      if (m === null || m[1] === undefined) continue;
      const level = m[1].toLowerCase();
      if (KNOWN_LEVELS.includes(level)) continue;
      findings.push({
        message: `tool '${hit.name}' declares unknown sensitivity '${level}'; extractor will fall through to capability-derived default`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: `replace with one of: ${KNOWN_LEVELS.join(', ')}`,
      });
    }
    return findings;
  },
};
