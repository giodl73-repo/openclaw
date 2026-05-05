/**
 * Reference markdown tracker. Parses raw bytes with `parseMd` from the
 * oc-paths substrate; valid iff no error-severity diagnostics. Callers
 * who want stricter schema validation (e.g., AGENTS.md must have a
 * `## Boundaries` section) layer it via `additionalCheck`.
 *
 * @module @openclaw/lkg/trackers/md
 */

import type { Diagnostic, MdAst, OcPath } from '@openclaw/oc-path';
import { parseMd } from '@openclaw/oc-path';
import type { LKGTracker, ValidationResult } from '../plugin-sdk/lkg/types.js';

export interface MdTrackerSnapshot {
  readonly ast: MdAst;
  readonly diagnostics: readonly Diagnostic[];
}

export interface MdTrackerOptions {
  readonly path: string;
  readonly ocPath?: OcPath;
  /**
   * Optional schema-level check layered on top of structural parse.
   * Called only when `parseMd` itself produced no error-severity
   * diagnostics. Returns `valid: false` to mark the file as
   * recovery-eligible despite a clean parse.
   */
  readonly additionalCheck?: (snapshot: MdTrackerSnapshot) => ValidationResult;
}

export function mdTracker(opts: MdTrackerOptions): LKGTracker<MdTrackerSnapshot> {
  return {
    path: opts.path,
    ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
    parse: (raw): MdTrackerSnapshot => {
      const result = parseMd(raw);
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
