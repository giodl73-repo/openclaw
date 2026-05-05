/**
 * Rule: `policy-starter-v0/tools/duplicate-tool-id`
 * Severity: warning
 * Applies to: TOOLS.md
 *
 * Flag: two `### name` sub-headings under `## Tools` declare the
 * same tool id. The extractor's last-writer-wins semantics (POL-033)
 * mean the first declaration is silently dropped — likely not what
 * the operator intended.
 *
 * Advisory-only by default: an auto-fix would have to GUESS which
 * declaration is canonical. The optional doctor fixer
 * `tools/dedupe-tool-id` keeps the LAST occurrence (matching the
 * extractor's last-writer-wins) so the IR doesn't change shape;
 * operators who disagree edit the file by hand.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

export const toolsDuplicateToolId: LintRule = {
  id: 'policy-starter-v0/tools/duplicate-tool-id',
  severity: 'warning',
  description: 'TOOLS.md declares the same `### name` tool id more than once',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    const seen = new Map<string, number>(); // name → first-seen line
    const findings: LintFinding[] = [];
    for (const hit of scanToolHeaders(ctx.ast)) {
      if (hit.name === '') continue;
      const prev = seen.get(hit.name);
      if (prev === undefined) {
        seen.set(hit.name, hit.line);
        continue;
      }
      findings.push({
        message: `tool '${hit.name}' declared more than once (first at line ${prev}); extractor's last-writer-wins drops the earlier declaration`,
        ocPath: `oc://TOOLS.md/Tools/${hit.name}`,
        line: hit.line,
        fixHint: 'keep one declaration; rename the other or remove it',
      });
    }
    return findings;
  },
};
