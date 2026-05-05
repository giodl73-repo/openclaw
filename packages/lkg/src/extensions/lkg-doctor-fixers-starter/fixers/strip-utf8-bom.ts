/**
 * Fixer: `lkg-starter-v0/lkg/strip-utf8-bom`
 * Pairs with: `lkg-starter-v0/lkg/utf8-bom-in-content`
 *
 * Remove the leading UTF-8 BOM (U+FEFF) from a tracked file's
 * content. Normalizes bytes so fingerprint comparisons across
 * machines agree even when one editor re-wrote with a BOM.
 *
 * Auto-safe: removes only the leading byte if present; idempotent
 * (re-running on BOM-free content is a no-op). NOT byte-fidelity-
 * preserving by design — the whole point is to normalize away the
 * BOM. Operators who want the BOM preserved disable this fixer.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';

const BOM = '﻿';

export const stripUtf8Bom: OcPathFixerSpec = {
  id: 'lkg-starter-v0/lkg/strip-utf8-bom',
  description: 'Strip leading UTF-8 BOM (U+FEFF) from tracked content',
  severity: 'info',
  appliesTo: '*',

  detect({ raw, fileName }) {
    if (!raw.startsWith(BOM)) return [];
    return [
      {
        match: {
          path: parseOcPath(`oc://${fileName}`),
          match: {
            kind: 'leaf' as const,
            valueText: BOM,
            leafType: 'string' as const,
            line: 1,
          },
        },
        message: `${fileName} has leading BOM`,
        fixHint: 'strip the U+FEFF prefix byte',
      },
    ];
  },

  fix({ raw }) {
    if (!raw.startsWith(BOM)) return raw;
    return raw.slice(BOM.length);
  },
};
