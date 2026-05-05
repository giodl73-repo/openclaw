/**
 * Fixer: `policy-starter-v0/tools/recommend-risk-from-caps`
 * Pairs with: `policy-starter-v0/tools/missing-risk-level`
 *
 * Insert a recommended `R<n>` token onto a TOOLS.md tool meta-line
 * that has no risk declaration. Recommendation is capability-derived:
 *
 *   IRREVERSIBLE_EXTERNAL  → R5 (critical) — irreversible blast radius
 *   FLEET_PRIVILEGED       → R4 (high)
 *   IDENTITY               → R4 (high)
 *   COMMUNICATE / WRITE    → R3 (medium)
 *   READ-only              → R1 (low)
 *   no recognized caps     → R1 (low)
 *
 * Auto-safe: additive (inserts a token, doesn't replace existing R<n>),
 * idempotent (re-running finds R<n> already present and skips).
 *
 * **Conservative bias**: when ambiguous, recommend HIGHER risk —
 * over-classifying is recoverable (operator can lower); under-
 * classifying isn't (an unknown tool gets routed past requires-approval).
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { replaceLine, scanToolHeaders } from './_tools-md-scan.js';

function recommendRiskFor(meta: string): string {
  if (/\bIRREVERSIBLE_EXTERNAL\b/.test(meta)) return 'R5';
  if (/\bFLEET_PRIVILEGED\b/.test(meta) || /\bIDENTITY\b/.test(meta)) return 'R4';
  if (/\bCOMMUNICATE\b/.test(meta) || /\bWRITE\b/.test(meta)) return 'R3';
  return 'R1';
}

export const toolsRecommendRiskFromCaps: OcPathFixerSpec = {
  id: 'policy-starter-v0/tools/recommend-risk-from-caps',
  description:
    'Insert a capability-derived `R<n>` risk token on TOOLS.md tools that lack one',
  severity: 'warning',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const findings = [];
    for (const hit of scanToolHeaders(ast)) {
      if (hit.meta === '') continue;
      if (/\bR[0-5]\b/.test(hit.meta)) continue;
      const rec = recommendRiskFor(hit.meta);
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${hit.name}`),
          match: {
            kind: 'insertion-point' as const,
            container: 'md-file' as const,
            line: hit.line,
          },
        },
        message: `tool '${hit.name}' has no risk; recommending ${rec} from capabilities`,
        fixHint: `prepend '${rec}, ' to the meta-line`,
      });
    }
    return findings;
  },

  fix({ raw, ast, match }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const hit = hits.find((h) => h.line === match.match.line);
    if (hit === undefined) return raw;
    if (/\bR[0-5]\b/.test(hit.meta)) return raw;
    const rec = recommendRiskFor(hit.meta);
    // Insert `<rec>, ` right after the `# ` separator.
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const original = lines[hit.line - 1] ?? '';
    // Match `### name` then the meta separator `#` and prepend.
    const next = original.replace(/(^### [\w-]+\s*#\s*)/, `$1${rec}, `);
    return replaceLine(raw, hit.line, next);
  },
};
