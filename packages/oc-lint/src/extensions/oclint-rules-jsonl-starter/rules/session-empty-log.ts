/**
 * Rule: `jsonl-starter-v0/session/empty-log`
 * Severity: info
 * Applies to: *.jsonl
 *
 * Flag: a session log file has no value lines (entirely blank or
 * malformed). This usually means the session never started or the log
 * was truncated; either is recoverability-relevant for LKG.
 *
 * **Teaching pattern**: count value lines via `findOcPaths('oc://X/*')`
 * — the wildcard expansion at the line-address slot enumerates only
 * value lines (blank/malformed lines aren't addressable). Empty
 * findings means no value lines, regardless of how the file failed.
 */
import { findOcPaths, parseOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const sessionEmptyLog: LintRule = {
  id: 'jsonl-starter-v0/session/empty-log',
  severity: 'info',
  description: 'session log file has no value lines',
  appliesTo: '{session,audit,events}*.jsonl',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonl') return [];
    const valueLines = findOcPaths(ctx.ast, parseOcPath(`oc://${ctx.fileName}/*`));
    if (valueLines.length > 0) return [];
    // Empty log has no value lines to anchor at — line 1 is the
    // file head by convention.
    return [
      {
        message: `${ctx.fileName}: no value lines in session log`,
        ocPath: `oc://${ctx.fileName}`,
        line: 1,
        fixHint: 'verify the session ran; check upstream writer',
      },
    ];
  },
};
