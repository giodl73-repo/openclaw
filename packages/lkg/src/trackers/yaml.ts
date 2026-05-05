/**
 * Reference YAML tracker. Parses raw bytes with `parseYaml` from the
 * oc-paths substrate; valid iff no error-severity diagnostics. Wraps
 * `yaml.parseDocument` so comments and structure are preserved (see
 * the bounding-box test for round-trip claims).
 *
 * @module @openclaw/lkg/trackers/yaml
 */

import type { Diagnostic, OcPath, YamlAst } from '@openclaw/oc-path';
import { parseYaml } from '@openclaw/oc-path';
import type { LKGTracker, ValidationResult } from '../plugin-sdk/lkg/types.js';

export interface YamlTrackerSnapshot {
  readonly ast: YamlAst;
  readonly diagnostics: readonly Diagnostic[];
}

export interface YamlTrackerOptions {
  readonly path: string;
  readonly ocPath?: OcPath;
  readonly additionalCheck?: (snapshot: YamlTrackerSnapshot) => ValidationResult;
}

export function yamlTracker(
  opts: YamlTrackerOptions,
): LKGTracker<YamlTrackerSnapshot> {
  return {
    path: opts.path,
    ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
    parse: (raw): YamlTrackerSnapshot => {
      const result = parseYaml(raw);
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
