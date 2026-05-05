/**
 * Test helper — construct a synthetic `OcPathMatch` for fix() calls
 * in unit tests. Tests don't have a real detect-stage match to thread
 * through, so they mint a placeholder.
 *
 * Real detect output uses richer match.kind (leaf with valueText, node
 * with descriptor, insertion-point with container). The fix bodies in
 * starter packs don't currently consume those fields beyond `path`, so
 * an `insertion-point` placeholder is sufficient for round-trip.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathMatch } from '@openclaw/oc-path';

export function syntheticMatch(ocPath: string, line = 1): OcPathMatch {
  return {
    path: parseOcPath(ocPath),
    match: { kind: 'insertion-point', container: 'jsonc-object', line },
  };
}

/** DoctorFinding helper for tests calling adapter.fix() directly. */
export function syntheticFinding(opts: {
  contributionId: string;
  fileName: string;
  filePath: string;
  ocPath: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error';
  line?: number;
}): {
  contributionId: string;
  severity: 'info' | 'warning' | 'error';
  fileName: string;
  filePath: string;
  message: string;
  ocPath: string;
  line: number;
  match: OcPathMatch;
} {
  return {
    contributionId: opts.contributionId,
    severity: opts.severity ?? 'info',
    fileName: opts.fileName,
    filePath: opts.filePath,
    message: opts.message ?? '',
    ocPath: opts.ocPath,
    line: opts.line ?? 1,
    match: syntheticMatch(opts.ocPath, opts.line ?? 1),
  };
}
