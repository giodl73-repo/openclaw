/**
 * Fixer: `lkg-starter-v0/lkg/scrub-sentinel-from-tracked`
 * Pairs with: `lkg-starter-v0/lkg/sentinel-in-content`
 *
 * Replace every occurrence of `__OPENCLAW_REDACTED__` with
 * `[REDACTED]` in tracked content. Pre-empts the LKG store's
 * sentinel guard rejecting the bytes at observe time.
 *
 * Auto-safe: the substitution is the same one the openclaw CLIs
 * use at output boundary (CLI-PINCH-033 / CLI-OCPATH-030 / etc.) —
 * a well-known scrub. Idempotent (re-running on already-scrubbed
 * content is a no-op).
 */
import { REDACTED_SENTINEL, parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';

const SCRUB_PLACEHOLDER = '[REDACTED]';

export const scrubSentinelFromTracked: OcPathFixerSpec = {
  id: 'lkg-starter-v0/lkg/scrub-sentinel-from-tracked',
  description:
    'Replace __OPENCLAW_REDACTED__ bytes with [REDACTED] so LKG observe succeeds',
  severity: 'warning',
  appliesTo: '*',

  detect({ raw, fileName }) {
    if (!raw.includes(REDACTED_SENTINEL)) return [];
    const idx = raw.indexOf(REDACTED_SENTINEL);
    const line = raw.slice(0, idx).split('\n').length;
    return [
      {
        match: {
          path: parseOcPath(`oc://${fileName}`),
          match: {
            kind: 'leaf' as const,
            valueText: REDACTED_SENTINEL,
            leafType: 'string' as const,
            line,
          },
        },
        message: `${fileName} contains sentinel bytes at line ${line}`,
        fixHint: 'replace with [REDACTED]',
      },
    ];
  },

  fix({ raw }) {
    if (!raw.includes(REDACTED_SENTINEL)) return raw;
    return raw.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
  },
};
