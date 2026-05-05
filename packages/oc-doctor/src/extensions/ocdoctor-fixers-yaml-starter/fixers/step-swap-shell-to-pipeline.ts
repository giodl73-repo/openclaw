/**
 * Fixer: `yaml-starter-v0/step/swap-shell-to-pipeline`
 * Pairs with: `lobster-yaml-starter-v0/step/shell-tool-collision`
 *
 * **Source**: openclaw/lobster issues #25, #26, #41 — `command:
 * openclaw.invoke ...` shells out and fails with `127: not found`.
 * The fix is to rewrite to `pipeline:`, which dispatches in-process.
 *
 * **Idempotency**: a step that already uses `pipeline:` (or whose
 * `command:` doesn't reference an in-process tool) is left alone.
 *
 * **Implementation**: byte-level splice on `raw` using the yaml
 * parser's per-token byte range — no AST mutation. The substrate's
 * `setOcPath` is value-AT-path, not key-rename, so this fix bypasses
 * setOcPath rather than violating the substrate's frozen-AST
 * contract. Adding a `renameKey` verb to the substrate is a separate
 * proposal; this byte-splice is correct without it. The fan-out
 * contract still applies: one `fix()` call rewrites exactly one key.
 *
 * The byte splice doesn't go through `emitYaml`, so the substrate's
 * emit-time sentinel guard doesn't fire on this path. The adapter's
 * post-fix sentinel scan (in `ocPathFixerContribution`) catches any
 * sentinel bytes before the host writer runs — defense-in-depth still
 * covers this fixer.
 */
import { isMap, isScalar, isSeq } from 'yaml';
import { parseOcPath } from '@openclaw/oc-path';
import { STARTER_IN_PROCESS_TOOLS } from '@openclaw/oc-lint';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

function isInProcessFirstToken(cmd: string): boolean {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  return STARTER_IN_PROCESS_TOOLS.includes(first);
}

export const stepSwapShellToPipeline: OcPathFixerSpec = {
  id: 'yaml-starter-v0/step/swap-shell-to-pipeline',
  description:
    'rewrite step `command:` / `run:` whose first token is an in-process tool to `pipeline:`',
  severity: 'error',
  appliesTo: '*.lobster',

  detect({ ast, fileName }) {
    if (ast.kind !== 'yaml') return [];
    const root = ast.doc.contents;
    if (!isMap(root)) return [];
    const stepsPair = root.items.find(
      (p) => isScalar(p.key) && p.key.value === 'steps',
    );
    if (stepsPair === undefined || !isSeq(stepsPair.value)) return [];

    const findings: Array<{
      match: { path: ReturnType<typeof parseOcPath>; match: { kind: 'leaf'; valueText: string; leafType: 'string'; line: number } };
      message: string;
      fixHint: string;
    }> = [];
    stepsPair.value.items.forEach((step, idx) => {
      if (!isMap(step)) return;
      for (const fieldName of ['command', 'run']) {
        const pair = step.items.find(
          (p) => isScalar(p.key) && p.key.value === fieldName,
        );
        if (pair === undefined || !isScalar(pair.value)) continue;
        const cmd = String(pair.value.value);
        if (!isInProcessFirstToken(cmd)) continue;
        const range = (pair.value as { range?: readonly [number, number, number] }).range;
        const line = range !== undefined && ast.kind === 'yaml'
          ? ast.lineCounter.linePos(range[0]).line
          : 1;
        findings.push({
          match: {
            path: parseOcPath(`oc://${fileName}/steps/${idx}/${fieldName}`),
            match: { kind: 'leaf', valueText: cmd, leafType: 'string', line },
          },
          message: `step[${idx}].${fieldName} should be \`pipeline:\` for in-process tool`,
          fixHint: `swap \`${fieldName}:\` → \`pipeline:\``,
        });
      }
    });
    return findings;
  },

  fix({ ast, raw, match }) {
    if (ast.kind !== 'yaml') return raw;
    if (match.match.kind !== 'leaf') return raw;

    // Extract idx + fieldName from the typed match path
    // (`oc://${fileName}/steps/${idx}/${fieldName}`).
    const idxRaw = match.path.item;
    const fieldName = match.path.field;
    const idx = idxRaw === undefined ? NaN : Number(idxRaw);
    if (!Number.isFinite(idx) || fieldName === undefined) return raw;

    const root = ast.doc.contents;
    if (!isMap(root)) return raw;
    const stepsPair = root.items.find(
      (p) => isScalar(p.key) && p.key.value === 'steps',
    );
    if (stepsPair === undefined || !isSeq(stepsPair.value)) return raw;

    const step = stepsPair.value.items[idx];
    if (!isMap(step)) return raw;
    const pair = step.items.find(
      (p) => isScalar(p.key) && p.key.value === fieldName,
    );
    if (pair === undefined || !isScalar(pair.value)) return raw;
    if (!isInProcessFirstToken(String(pair.value.value))) return raw;

    // Byte-level splice: replace the key token in `raw` directly. The
    // yaml parser annotates each Scalar with a `range: [start, end, ...]`
    // tuple of byte offsets. The key's range is just the key token
    // ('command' or 'run'), exclusive of the trailing colon — slicing
    // raw and replacing the segment preserves all surrounding bytes
    // (whitespace, comments, value, indentation).
    const keyRange = (pair.key as { range?: readonly [number, number, number] }).range;
    if (keyRange === undefined) return raw;
    const [keyStart, keyEnd] = keyRange;
    if (typeof keyStart !== 'number' || typeof keyEnd !== 'number') return raw;
    return raw.slice(0, keyStart) + 'pipeline' + raw.slice(keyEnd);
  },
};
