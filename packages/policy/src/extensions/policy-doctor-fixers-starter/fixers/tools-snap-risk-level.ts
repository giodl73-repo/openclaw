/**
 * Fixer: `policy-starter-v0/tools/snap-risk-level`
 * Pairs with: `policy-starter-v0/tools/unknown-risk-level`
 *
 * When a tool declares an out-of-range `R<n>` (R6+, negative), snap
 * to the nearest valid bound: R6+ → R5, R-1 → R0.
 *
 * **Optional** — operator opt-in. Snapping makes a value decision
 * (the operator's intent for "R7" is ambiguous: did they mean
 * "highest possible," or did they mistype R5?). The default
 * (snap-to-bound) is conservative.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { replaceLine, scanToolHeaders } from './_tools-md-scan.js';

export const toolsSnapRiskLevel: OcPathFixerSpec = {
  id: 'policy-starter-v0/tools/snap-risk-level',
  description: 'Snap out-of-range `R<n>` (R6+ or negative) to the nearest valid bound',
  severity: 'warning',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const findings = [];
    for (const hit of scanToolHeaders(ast)) {
      const m = /\bR(-?\d+)\b/.exec(hit.meta);
      if (m === null || m[1] === undefined) continue;
      const n = Number(m[1]);
      if (n >= 0 && n <= 5) continue;
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${hit.name}`),
          match: {
            kind: 'leaf' as const,
            valueText: `R${n}`,
            leafType: 'string' as const,
            line: hit.line,
          },
        },
        message: `tool '${hit.name}' has out-of-range R${n}; snapping to ${n > 5 ? 'R5' : 'R0'}`,
        fixHint: n > 5 ? 'snap to R5 (critical)' : 'snap to R0',
      });
    }
    return findings;
  },

  fix({ raw, ast, match }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const hit = hits.find((h) => h.line === match.match.line);
    if (hit === undefined) return raw;
    const m = /\bR(-?\d+)\b/.exec(hit.meta);
    if (m === null || m[1] === undefined) return raw;
    const n = Number(m[1]);
    if (n >= 0 && n <= 5) return raw;
    const target = n > 5 ? 'R5' : 'R0';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const original = lines[hit.line - 1] ?? '';
    const next = original.replace(/\bR-?\d+\b/, target);
    return replaceLine(raw, hit.line, next);
  },
};
