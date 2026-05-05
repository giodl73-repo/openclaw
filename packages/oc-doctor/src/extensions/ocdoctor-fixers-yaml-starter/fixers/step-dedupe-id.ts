/**
 * Fixer: `yaml-starter-v0/step/dedupe-id`
 * Pairs with: `lobster-yaml-starter-v0/step/duplicate-id`
 *
 * **Source**: openclaw/lobster issues #76, #77 — for_each + parallel
 * specs require unique step IDs. The fix renames duplicates by
 * appending an index suffix.
 *
 * **Configurable** via options:
 *   - `strategy: 'index-suffix'` (default) — `<id>` → `<id>_<n>`
 *   - `strategy: 'rename-second'` — `<id>` → `<id>_dupe`
 *
 * **Severity is `info` (not warning/error)** — the fix is intentionally
 * partial. Renaming an id can break downstream `$id.stdout` references
 * in `stdin:` fields, and walking those refs to update them is a
 * non-trivial scope decision (do we update all matches blindly? what
 * if the operator wanted the second `a` to be the receiver?). The
 * partner lint rule
 * `lobster-yaml-starter-v0/step/undefined-stdin-ref` (severity `error`)
 * catches the resulting dangling refs at the next lint pass — that's
 * the follow-through. Operators run lint→fix→lint and the `error`
 * dangling-ref rule surfaces what the dedupe fix didn't repair.
 *
 * Considered alternative: extend this fixer to rewrite `$<oldId>.stdout`
 * in subsequent steps. Rejected because the rename is semantically
 * ambiguous — if step[3] referenced `$a.stdout`, the operator's
 * intent (was that the first `a` or the renamed second?) is not
 * recoverable from the AST. Auto-rewriting would silently change
 * behavior; failing-loud via the paired error rule preserves operator
 * agency.
 *
 * **Substrate routing**: mutation goes through `setOcPath` (the
 * universal substrate verb) rather than direct yaml-package AST
 * mutation. The detect/fix fan-out semantic means each duplicate is a
 * separate detect finding and a separate `fix()` call — `fix()`
 * renames exactly the one element addressed by `match.path`.
 */
import { isMap, isScalar, isSeq } from 'yaml';
import { emitYaml, parseOcPath, setOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export interface DedupeIdOptions {
  readonly strategy: 'index-suffix' | 'rename-second';
}

const DEFAULTS: DedupeIdOptions = { strategy: 'index-suffix' };

export const stepDedupeId: OcPathFixerSpec<DedupeIdOptions> = {
  id: 'yaml-starter-v0/step/dedupe-id',
  description: 'rename duplicate step ids to make them unique',
  // Info severity acknowledges the partial fix — see file-level JSDoc.
  // The paired error rule `step/undefined-stdin-ref` catches what this
  // fix doesn't repair (dangling `$<oldId>.stdout` references).
  severity: 'info',
  // Speculative — the partial-fix design (rename without ref-rewrite)
  // is a deliberate trade-off we want to validate before stabilizing.
  status: 'speculative',
  appliesTo: '*.lobster',
  defaultOptions: DEFAULTS,

  detect({ ast, fileName }) {
    if (ast.kind !== 'yaml') return [];
    const root = ast.doc.contents;
    if (!isMap(root)) return [];
    const stepsPair = root.items.find(
      (p) => isScalar(p.key) && p.key.value === 'steps',
    );
    if (stepsPair === undefined || !isSeq(stepsPair.value)) return [];

    const seen = new Map<string, number>();
    const findings: Array<{
      match: { path: ReturnType<typeof parseOcPath>; match: { kind: 'leaf'; valueText: string; leafType: 'string'; line: number } };
      message: string;
      fixHint: string;
    }> = [];
    stepsPair.value.items.forEach((step, idx) => {
      if (!isMap(step)) return;
      const idPair = step.items.find(
        (p) => isScalar(p.key) && p.key.value === 'id',
      );
      if (idPair === undefined || !isScalar(idPair.value)) return;
      const id = String(idPair.value.value);
      const prevIdx = seen.get(id);
      if (prevIdx !== undefined) {
        const range = (idPair.value as { range?: readonly [number, number, number] }).range;
        const line = range !== undefined && ast.kind === 'yaml'
          ? ast.lineCounter.linePos(range[0]).line
          : 1;
        findings.push({
          match: {
            path: parseOcPath(`oc://${fileName}/steps/${idx}/id`),
            match: { kind: 'leaf', valueText: id, leafType: 'string', line },
          },
          message: `step[${idx}].id \`${id}\` collides with step[${prevIdx}]`,
          fixHint: 'rename to make unique',
        });
      } else {
        seen.set(id, idx);
      }
    });
    return findings;
  },

  fix({ ast, raw, match, options }) {
    if (ast.kind !== 'yaml') return raw;
    if (match.match.kind !== 'leaf') return raw;
    const opts = options ?? DEFAULTS;
    const oldId = match.match.valueText;

    // Extract idx from path.item (string form) — matches detect's path
    // construction `oc://${fileName}/steps/${idx}/id`.
    const idxRaw = match.path.item;
    const idx = idxRaw === undefined ? NaN : Number(idxRaw);
    if (!Number.isFinite(idx)) return raw;

    const newId =
      opts.strategy === 'rename-second' ? `${oldId}_dupe` : `${oldId}_${idx}`;

    const result = setOcPath(ast, match.path, newId);
    if (!result.ok) return raw;
    if (result.ast.kind !== 'yaml') return raw;
    // Route through substrate `emitYaml` — applies sentinel guard at
    // every leaf even though the yaml package's own `toString` would
    // also produce valid bytes. Render mode because the AST has been
    // mutated and `ast.raw` is stale.
    return emitYaml(result.ast, { mode: 'render' });
  },
};
