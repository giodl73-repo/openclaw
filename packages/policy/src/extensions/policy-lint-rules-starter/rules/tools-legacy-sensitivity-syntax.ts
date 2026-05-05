/**
 * Rule: `policy-starter-v0/tools/legacy-sensitivity-syntax`
 * Severity: info
 * Applies to: TOOLS.md
 *
 * Flag: tool meta-line uses bare-word sensitivity (`### t # R3, READ,
 * public`) rather than the canonical `sensitivity:<level>` form.
 *
 * Both forms work in the extractor (POL-052), but the canonical
 * form is what doctor fixers / lint rules / future readers can reason
 * about uniformly. This rule + its paired fixer
 * (`tools/migrate-sensitivity-syntax`) drive workspaces toward the
 * canonical form over time.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

const KNOWN_BARE_WORDS = ['public', 'internal', 'confidential', 'restricted'];

export const toolsLegacySensitivitySyntax: LintRule = {
  id: 'policy-starter-v0/tools/legacy-sensitivity-syntax',
  severity: 'info',
  description:
    'TOOLS.md tool declares sensitivity via legacy bare-word; prefer canonical `sensitivity:<level>`',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      if (hit.meta === '') continue;
      // Skip if explicit `sensitivity:<level>` is already there.
      if (/\bsensitivity\s*:\s*\w+/i.test(hit.meta)) continue;
      // Detect bare-word token-level match.
      const tokens = hit.meta.toLowerCase().split(/[,\s]+/).map((t) => t.trim());
      const bareMatch = tokens.find((t) => KNOWN_BARE_WORDS.includes(t));
      if (bareMatch === undefined) continue;
      findings.push({
        message: `tool '${hit.name}' uses legacy bare-word sensitivity '${bareMatch}'; prefer 'sensitivity:${bareMatch}'`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: `replace '${bareMatch}' with 'sensitivity:${bareMatch}'`,
      });
    }
    return findings;
  },
};
