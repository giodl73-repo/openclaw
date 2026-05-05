/**
 * Reference JSONC tracker. Parses raw bytes with `parseJsonc` from the
 * oc-paths substrate; valid iff no error-severity diagnostics. Comments
 * and trailing commas are tolerated (that's what makes it JSONC).
 *
 * @module @openclaw/lkg/trackers/jsonc
 */

import type { Diagnostic, JsoncAst, OcPath } from '@openclaw/oc-path';
import { parseJsonc } from '@openclaw/oc-path';
import type { LKGTracker, ValidationResult } from '../plugin-sdk/lkg/types.js';

export interface JsoncTrackerSnapshot {
  readonly ast: JsoncAst;
  readonly diagnostics: readonly Diagnostic[];
}

export interface JsoncTrackerOptions {
  readonly path: string;
  readonly ocPath?: OcPath;
  readonly additionalCheck?: (snapshot: JsoncTrackerSnapshot) => ValidationResult;
}

export function jsoncTracker(
  opts: JsoncTrackerOptions,
): LKGTracker<JsoncTrackerSnapshot> {
  return {
    path: opts.path,
    ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
    parse: (raw): JsoncTrackerSnapshot => {
      const result = parseJsonc(raw);
      return { ast: result.ast, diagnostics: result.diagnostics };
    },
    validate: (snapshot): ValidationResult => {
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
