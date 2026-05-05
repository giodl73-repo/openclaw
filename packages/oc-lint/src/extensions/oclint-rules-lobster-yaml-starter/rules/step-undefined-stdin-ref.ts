/**
 * Rule: `lobster-yaml-starter-v0/step/undefined-stdin-ref`
 * Severity: error
 * Applies to: *.lobster
 *
 * **Source**: openclaw/lobster issue #41 — `stdin: $stepId.stdout`
 * where `stepId` is not an earlier step (typo, forward reference, or
 * deleted step). Runtime fails with cryptic missing-stream error;
 * static lint catches it before runtime.
 */
import { findOcPaths, parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';

const STEPID_REF = /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.(?:stdout|json|stderr)/;

export const stepUndefinedStdinRef: LintRule = {
  id: 'lobster-yaml-starter-v0/step/undefined-stdin-ref',
  severity: 'error',
  description: 'step `stdin:` references a step id that is not defined earlier in the workflow',
  appliesTo: '*.lobster',
  check(ctx) {
    if (ctx.ast.kind !== 'yaml') return [];
    const stepMatches = findOcPaths(ctx.ast, parseOcPath(`oc://${ctx.fileName}/steps/*`));
    const orderedIdx = stepMatches
      .map((m) => m.path.item)
      .filter((s): s is string => s !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    const seenIds = new Set<string>();
    const out: LintFinding[] = [];
    for (const idx of orderedIdx) {
      const stdinMatch = resolveOcPath(
        ctx.ast,
        parseOcPath(`oc://${ctx.fileName}/steps/${idx}/stdin`),
      );
      if (stdinMatch !== null && stdinMatch.kind === 'leaf') {
        const m = STEPID_REF.exec(stdinMatch.valueText);
        if (m !== null && m[1] !== undefined && !seenIds.has(m[1])) {
          out.push({
            message: `${ctx.fileName}: step[${idx}].stdin references undefined or forward step id \`${m[1]}\` (no earlier step has \`id: ${m[1]}\`)`,
            ocPath: `oc://${ctx.fileName}/steps/${idx}/stdin`,
            line: stdinMatch.line,
            fixHint: `either rename the ref to match an existing earlier step's id, or add a step with \`id: ${m[1]}\` before step[${idx}]`,
          });
        }
      }
      // Add this step's id to seen AFTER probing its stdin, so self-ref is caught.
      const idMatch = resolveOcPath(
        ctx.ast,
        parseOcPath(`oc://${ctx.fileName}/steps/${idx}/id`),
      );
      if (idMatch !== null && idMatch.kind === 'leaf') {
        seenIds.add(idMatch.valueText);
      }
    }
    return out;
  },
};
