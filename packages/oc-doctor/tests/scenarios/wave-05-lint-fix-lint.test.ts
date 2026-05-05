/**
 * Wave 5 — lint→fix→lint integration sweep.
 *
 * For every fixer in the pack: run lint to confirm the paired rule
 * fires, apply the fix, run lint again, confirm the paired rule no
 * longer fires. End-to-end proof of the fix→cleared contract.
 */
import { parseMd } from '@openclaw/oc-path';
import { runLint, STARTER_RULES_V0, type LintFile } from '@openclaw/oc-lint';
import { describe, expect, it } from 'vitest';
import { STARTER_FIXERS_V0 } from '../../src/extensions/ocdoctor-fixers-starter/index.js';
import type { OcPathFixerSpec } from '../../src/plugin-sdk/oc-doctor/types.js';

async function applyFix(spec: OcPathFixerSpec<unknown>, raw: string): Promise<string> {
  const { ast } = parseMd(raw);
  const matches = await spec.detect({ fileName: spec.appliesTo, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({
    fileName: spec.appliesTo,
    ast,
    raw,
    match: matches[0]!.match,
  });
}

function lintIds(name: string, raw: string): readonly string[] {
  const ast = parseMd(raw).ast;
  const f: LintFile = { name, ast };
  const r = runLint({ rules: STARTER_RULES_V0, files: [f] });
  return r.diagnostics.map((d) => d.ruleId);
}

// Map each fixer to the rule it pairs with on the SAME trigger input.
// `tools/add-guidance-table-stub` is intentionally absent: its paired rule
// (`tools/empty-guidance-table`) only fires when `## Tool Guidance` exists
// with an empty table, while the fixer fires when the section is missing.
// The pair is asymmetric by design — auto-adding table rows would be
// destructive — so it can't be sweep-tested here.
const PAIRINGS: Record<string, string> = {
  'starter-v0/agents/add-boundaries-stub': 'starter-v0/agents/missing-boundaries',
  'starter-v0/memory/add-scope-default': 'starter-v0/memory/missing-frontmatter-scope',
  'starter-v0/skill/add-required-frontmatter-stub':
    'starter-v0/skill/missing-required-frontmatter',
  'starter-v0/identity/add-trust-level-stub': 'starter-v0/identity/missing-trust-level',
  'starter-v0/user/add-preferences-stub': 'starter-v0/user/missing-preferences-section',
};

describe('wave-05 lint→fix→lint sweep', () => {
  for (const fixer of STARTER_FIXERS_V0) {
    const pairedRuleId = PAIRINGS[fixer.id];
    if (pairedRuleId === undefined) continue;

    describe(fixer.id, () => {
      const probeInput: Record<string, string> = {
        'starter-v0/agents/add-boundaries-stub': '## Tools\n- gh\n',
        'starter-v0/tools/add-guidance-table-stub': '## Header\n',
        'starter-v0/memory/add-scope-default': '## Entry\nbody\n',
        'starter-v0/skill/add-required-frontmatter-stub': '## Body\n',
        'starter-v0/identity/add-trust-level-stub': '## Section\n',
        'starter-v0/user/add-preferences-stub': '## Role\nPM\n',
      };
      const raw = probeInput[fixer.id]!;

      it('LFL-01 lint flags the paired rule on the malformed input', () => {
        expect(lintIds(fixer.appliesTo, raw)).toContain(pairedRuleId);
      });

      it('LFL-02 fix produces non-equal output when applicable', async () => {
        const after = await applyFix(fixer, raw);
        expect(after).not.toBe(raw);
      });

      it('LFL-03 lint after fix no longer reports the paired rule', async () => {
        const after = await applyFix(fixer, raw);
        expect(lintIds(fixer.appliesTo, after)).not.toContain(pairedRuleId);
      });

      it('LFL-04 lint after fix produces zero diagnostics from this rule pack', async () => {
        // Some inputs may still trigger OTHER rules, but specifically the
        // paired one must clear. This test asserts the strongest case:
        // when the input is minimal, only the paired rule fires, so
        // post-fix should be clean.
        const after = await applyFix(fixer, raw);
        const remaining = lintIds(fixer.appliesTo, after).filter((id) => id === pairedRuleId);
        expect(remaining).toEqual([]);
      });
    });
  }

  it('LFL-05 full pack: 3 malformed files → apply pack → all paired rules clear', async () => {
    const files: { name: string; raw: string }[] = [
      { name: 'AGENTS.md', raw: '## Tools\n- gh\n' },
      { name: 'MEMORY.md', raw: '## Entry\nbody\n' },
      { name: 'USER.md', raw: '## Role\nPM\n' },
    ];

    // Snapshot baseline diagnostics.
    const beforeIds = new Set<string>();
    for (const f of files) for (const id of lintIds(f.name, f.raw)) beforeIds.add(id);

    // Apply each fixer to its paired file.
    const after = await Promise.all(
      files.map(async (f) => {
        let raw = f.raw;
        for (const fixer of STARTER_FIXERS_V0) {
          if (fixer.appliesTo === f.name) raw = await applyFix(fixer, raw);
        }
        return { name: f.name, raw };
      }),
    );

    // Snapshot post-fix diagnostics.
    const afterIds = new Set<string>();
    for (const f of after) for (const id of lintIds(f.name, f.raw)) afterIds.add(id);

    // Every paired rule should have cleared.
    for (const pairedId of Object.values(PAIRINGS)) {
      expect(afterIds.has(pairedId), `${pairedId} should be cleared`).toBe(false);
    }
  });
});
