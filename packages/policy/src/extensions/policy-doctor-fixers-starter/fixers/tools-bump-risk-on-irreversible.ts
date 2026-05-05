/**
 * Fixer: `policy-starter-v0/tools/bump-risk-on-irreversible`
 * Pairs with: `policy-starter-v0/tools/irreversible-low-risk-mismatch`
 *
 * When a TOOLS.md tool declares both `IRREVERSIBLE_EXTERNAL` and
 * R0..R3, bump the risk to R4 (high). Doesn't push to R5 — true
 * critical-vs-high is an operator decision based on blast radius.
 *
 * Auto-safe: additive bump (only raises, never lowers), idempotent
 * (re-running finds R4+ and skips).
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { replaceLine, scanToolHeaders } from './_tools-md-scan.js';

export const toolsBumpRiskOnIrreversible: OcPathFixerSpec = {
  id: 'policy-starter-v0/tools/bump-risk-on-irreversible',
  description:
    'Bump R0..R3 to R4 when paired with IRREVERSIBLE_EXTERNAL capability',
  severity: 'warning',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const findings = [];
    for (const hit of scanToolHeaders(ast)) {
      if (hit.meta === '') continue;
      if (!/\bIRREVERSIBLE_EXTERNAL\b/.test(hit.meta)) continue;
      const m = /\bR([0-3])\b/.exec(hit.meta);
      if (m === null) continue;
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${hit.name}`),
          match: {
            kind: 'leaf' as const,
            valueText: `R${m[1]}`,
            leafType: 'string' as const,
            line: hit.line,
          },
        },
        message: `tool '${hit.name}' is IRREVERSIBLE_EXTERNAL with R${m[1]}; bumping to R4`,
        fixHint: 'raise risk to R4 (high)',
      });
    }
    return findings;
  },

  fix({ raw, ast, match }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const hit = hits.find((h) => h.line === match.match.line);
    if (hit === undefined) return raw;
    if (!/\bIRREVERSIBLE_EXTERNAL\b/.test(hit.meta)) return raw;
    const m = /\bR([0-3])\b/.exec(hit.meta);
    if (m === null) return raw;
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const original = lines[hit.line - 1] ?? '';
    const next = original.replace(/\bR[0-3]\b/, 'R4');
    return replaceLine(raw, hit.line, next);
  },
};
