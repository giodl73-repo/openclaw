/**
 * Reference JSONL tracker. Parses raw bytes with `parseJsonl` from the
 * oc-paths substrate; valid iff no malformed lines (each non-empty line
 * must be JSON-parseable). Tail-corruption is the common failure mode
 * for session logs — a half-flushed JSON-encoded turn ends up here as
 * an error-severity diagnostic, triggering recovery.
 *
 * @module @openclaw/lkg/trackers/jsonl
 */

import type { Diagnostic, JsonlAst, OcPath } from '@openclaw/oc-path';
import { parseJsonl } from '@openclaw/oc-path';
import type { LKGTracker, ValidationResult } from '../plugin-sdk/lkg/types.js';

export interface JsonlTrackerSnapshot {
  readonly ast: JsonlAst;
  readonly diagnostics: readonly Diagnostic[];
}

export interface JsonlTrackerOptions {
  readonly path: string;
  readonly ocPath?: OcPath;
  readonly additionalCheck?: (snapshot: JsonlTrackerSnapshot) => ValidationResult;
}

export function jsonlTracker(
  opts: JsonlTrackerOptions,
): LKGTracker<JsonlTrackerSnapshot> {
  return {
    path: opts.path,
    ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
    parse: (raw): JsonlTrackerSnapshot => {
      const result = parseJsonl(raw);
      return { ast: result.ast, diagnostics: result.diagnostics };
    },
    validate: (snapshot): ValidationResult => {
      // Malformed JSONL lines surface as warning-severity diagnostics
      // from the substrate parser (soft-error policy). The tracker
      // promotes them to recovery-triggering issues — a half-flushed
      // turn at the tail of a session log is exactly what we want LKG
      // to roll back.
      const malformedLines = snapshot.ast.lines.filter((l) => l.kind === 'malformed');
      if (malformedLines.length > 0) {
        return {
          valid: false,
          issues: malformedLines.map((l) => ({
            path: `line:${l.line}`,
            message: `malformed JSONL line at ${l.line}`,
            code: 'OC_JSONL_LINE_MALFORMED',
          })),
        };
      }
      const errs = snapshot.diagnostics.filter((d) => d.severity === 'error');
      if (errs.length > 0) {
        return {
          valid: false,
          issues: errs.map((d) => ({
            path: `line:${d.line}`,
            message: d.message,
            ...(d.code !== undefined ? { code: d.code } : {}),
          })),
        };
      }
      if (opts.additionalCheck !== undefined) return opts.additionalCheck(snapshot);
      return { valid: true, issues: [] };
    },
  };
}
