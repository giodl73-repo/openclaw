/**
 * Fixer: `policy-starter-v0/tools/migrate-sensitivity-syntax`
 * Pairs with: `policy-starter-v0/tools/legacy-sensitivity-syntax`
 *
 * Rewrite a TOOLS.md tool meta-line that uses bare-word sensitivity
 * (`### t # R3, READ, public`) into the canonical form
 * (`### t # R3, READ, sensitivity:public`).
 *
 * Auto-safe: additive at the syntax level (replaces a token, doesn't
 * delete or restructure), idempotent (re-running finds canonical form
 * already present and skips).
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { replaceLine, scanToolHeaders } from './_tools-md-scan.js';

const KNOWN_BARE_WORDS = ['public', 'internal', 'confidential', 'restricted'];

export const toolsMigrateSensitivitySyntax: OcPathFixerSpec = {
  id: 'policy-starter-v0/tools/migrate-sensitivity-syntax',
  description:
    'Rewrite TOOLS.md bare-word sensitivity (`public`) into canonical `sensitivity:public`',
  severity: 'info',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const findings = [];
    for (const hit of scanToolHeaders(ast)) {
      if (hit.meta === '') continue;
      if (/\bsensitivity\s*:\s*\w+/i.test(hit.meta)) continue;
      const tokens = hit.meta.toLowerCase().split(/[,\s]+/).map((t) => t.trim());
      const bareMatch = tokens.find((t) => KNOWN_BARE_WORDS.includes(t));
      if (bareMatch === undefined) continue;
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${hit.name}`),
          match: { kind: 'leaf' as const, valueText: bareMatch, leafType: 'string' as const, line: hit.line },
        },
        message: `migrate '${bareMatch}' → 'sensitivity:${bareMatch}' on tool '${hit.name}'`,
        fixHint: 'replace bare-word with canonical sensitivity:<level>',
      });
    }
    return findings;
  },

  fix({ raw, ast, match }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const hit = hits.find((h) => h.line === match.match.line);
    if (hit === undefined) return raw;
    if (/\bsensitivity\s*:\s*\w+/i.test(hit.meta)) return raw; // already canonical
    const tokens = hit.meta.toLowerCase().split(/[,\s]+/).map((t) => t.trim());
    const bareMatch = tokens.find((t) => KNOWN_BARE_WORDS.includes(t));
    if (bareMatch === undefined) return raw;
    // Replace the bare word in the raw line, preserving original case
    // surroundings. Use a word-boundary regex.
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const original = lines[hit.line - 1] ?? '';
    const re = new RegExp(`\\b${bareMatch}\\b`, 'i');
    const next = original.replace(re, `sensitivity:${bareMatch}`);
    return replaceLine(raw, hit.line, next);
  },
};
