/**
 * Fixer: `jsonl-starter-v0/session/quarantine-malformed-line`
 * Pairs with: `jsonl-starter-v0/session/malformed-line` (lint warning)
 *
 * Replaces every malformed line with a quarantine event of shape
 * `{"event":"malformed","original":"<original line>","_auto":true}`.
 * Preserves the original bytes verbatim under the `original` key so
 * forensic analysis remains possible.
 *
 * **Idempotency**: a quarantine event is itself valid JSON, so
 * re-running on a quarantined file produces no further detections.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export const sessionQuarantineMalformedLine: OcPathFixerSpec = {
  id: 'jsonl-starter-v0/session/quarantine-malformed-line',
  description:
    'Replace malformed lines with `{"event":"malformed","original":"…"}` quarantine events',
  severity: 'warning',
  appliesTo: '{session,audit,events}*.jsonl',

  detect({ ast, fileName }) {
    if (ast.kind !== 'jsonl') return [];
    return ast.lines
      .filter((l) => l.kind === 'malformed')
      .map((l) => ({
        match: {
          path: parseOcPath(`oc://${fileName}/L${l.line}`),
          // Malformed lines aren't structurally addressable as a node;
          // surface as an insertion-point shaped match with the line's
          // address — semantically: "this line should be replaced".
          match: { kind: 'insertion-point', container: 'jsonl-file', line: l.line } as const,
        },
        message: `${fileName}: L${l.line} malformed — quarantine candidate`,
        fixHint: 'replace with `{"event":"malformed","original":"…"}`',
      }));
  },

  fix({ ast, raw }) {
    if (ast.kind !== 'jsonl') return raw;
    if (ast.lines.every((l) => l.kind !== 'malformed')) return raw;

    // Walk raw line-by-line in parallel with the AST. Replace any
    // malformed line with a quarantine event.
    const trailingNewline = raw.endsWith('\n');
    const bodyLines = (trailingNewline ? raw.slice(0, -1) : raw).split('\n');
    for (let i = 0; i < ast.lines.length; i++) {
      const astLine = ast.lines[i];
      if (astLine?.kind !== 'malformed') continue;
      bodyLines[i] = JSON.stringify({
        event: 'malformed',
        original: astLine.raw,
        _auto: true,
      });
    }
    return bodyLines.join('\n') + (trailingNewline ? '\n' : '');
  },
};
