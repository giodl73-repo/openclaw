/**
 * Fixer: `policy-starter-v0/tools/snap-sensitivity-token`
 * Pairs with: `policy-starter-v0/tools/unknown-sensitivity-token`
 *
 * When a tool declares `sensitivity:<bogus>` not in {public, internal,
 * confidential, restricted}, snap to a configured target (default
 * `internal`).
 *
 * **Optional** — operator opt-in. Lives in `STARTER_FIXERS_V0_OPTIONAL`
 * because snapping makes a value choice (which level is "right" for
 * `sensitivity:bogus`?) — not auto-safe in the same way as
 * migrate-sensitivity-syntax. Configurable via `targetLevel` option.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { replaceLine, scanToolHeaders } from './_tools-md-scan.js';

export interface SnapSensitivityOptions {
  readonly targetLevel: 'public' | 'internal' | 'confidential' | 'restricted';
}

const DEFAULTS: SnapSensitivityOptions = {
  // `internal` is the default in the extractor's capability-derived
  // path; snapping unknown tokens here matches the same default.
  targetLevel: 'internal',
};

const KNOWN_LEVELS = ['public', 'internal', 'confidential', 'restricted'];

export const toolsSnapSensitivityToken: OcPathFixerSpec<SnapSensitivityOptions> = {
  id: 'policy-starter-v0/tools/snap-sensitivity-token',
  description:
    'Snap unknown `sensitivity:<bogus>` to a configured target (default `internal`)',
  severity: 'warning',
  appliesTo: 'TOOLS.md',
  defaultOptions: DEFAULTS,

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const findings = [];
    for (const hit of scanToolHeaders(ast)) {
      const m = /\bsensitivity\s*:\s*(\w+)/i.exec(hit.meta);
      if (m === null || m[1] === undefined) continue;
      const level = m[1].toLowerCase();
      if (KNOWN_LEVELS.includes(level)) continue;
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${hit.name}`),
          match: {
            kind: 'leaf' as const,
            valueText: level,
            leafType: 'string' as const,
            line: hit.line,
          },
        },
        message: `tool '${hit.name}' has unknown sensitivity '${level}'`,
        fixHint: `snap to configured target`,
      });
    }
    return findings;
  },

  fix({ raw, ast, match, options }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const hit = hits.find((h) => h.line === match.match.line);
    if (hit === undefined) return raw;
    const opts = options ?? DEFAULTS;
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const original = lines[hit.line - 1] ?? '';
    const next = original.replace(/(\bsensitivity\s*:\s*)\w+/i, `$1${opts.targetLevel}`);
    return replaceLine(raw, hit.line, next);
  },
};
