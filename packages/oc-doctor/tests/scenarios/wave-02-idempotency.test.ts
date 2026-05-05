/**
 * Wave 2 — idempotency property.
 *
 * Every fixer in starter-v0 satisfies `fix(fix(raw)) === fix(raw)` over
 * a corpus of synthetic inputs. The contract is unconditional — even
 * inputs that are already correct, malformed, or partially fixed must
 * stabilize after one application.
 */
import { parseMd } from '@openclaw/oc-path';
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

describe('wave-02 idempotency', () => {
  // Generic corpus: covers the input shapes most likely to break a fixer.
  const corpus: string[] = [
    '',
    '\n',
    '   \n',
    '## H\n',
    '## H\n- a\n',
    '## H\n- a\n## I\n- b\n',
    '---\n---\n',
    '---\nk: v\n---\n',
    '---\nk: v\n---\n## H\n',
    '---\n\n\n---\n## H\n',
    '## A\n## B\n## C\n',
    '## H\r\n- a\r\n',
    '﻿## H\n', // BOM
    '## H\n```\nfence\n```\n',
    'Just preamble.\n',
    'Just preamble. No headings or sections.\n',
  ];

  for (const fixer of STARTER_FIXERS_V0) {
    describe(fixer.id, () => {
      for (const raw of corpus) {
        const label = JSON.stringify(raw.slice(0, 30));
        it(`is idempotent on input ${label}`, async () => {
          const once = await applyFix(fixer, raw);
          const twice = await applyFix(fixer, once);
          expect(twice).toBe(once);
        });
      }
    });
  }

  it('cross-fixer: applying every fixer in pack order is idempotent', async () => {
    const inputs = [
      '## Tools\n- gh\n', // AGENTS.md scope (will trigger boundaries fixer)
      '## Entry\nbody\n', // MEMORY.md scope
      '## Role\n', // USER.md scope
    ];
    for (const raw of inputs) {
      let next = raw;
      for (const fixer of STARTER_FIXERS_V0) {
        next = await applyFix(fixer, next);
      }
      // Apply pack again — should not change anything since each fixer
      // only acts on its own appliesTo, and each is idempotent.
      let again = next;
      for (const fixer of STARTER_FIXERS_V0) {
        again = await applyFix(fixer, again);
      }
      expect(again).toBe(next);
    }
  });

  it('every fixer detects nothing on an already-fixed input', async () => {
    for (const fixer of STARTER_FIXERS_V0) {
      // Build a minimal input then run fixer once — the fixed result
      // should detect zero findings.
      const probe: Record<string, string> = {
        'starter-v0/agents/add-boundaries-stub': '## Tools\n',
        'starter-v0/tools/add-guidance-table-stub': '## Header\n',
        'starter-v0/memory/add-scope-default': '## Entry\n',
        'starter-v0/skill/add-required-frontmatter-stub': '## Body\n',
        'starter-v0/identity/add-trust-level-stub': '## Section\n',
        'starter-v0/user/add-preferences-stub': '## Role\n',
      };
      const raw = probe[fixer.id];
      if (raw === undefined) {
        throw new Error(`no probe input for fixer ${fixer.id}`);
      }
      const fixed = await applyFix(fixer, raw);
      const reAst = parseMd(fixed).ast;
      const matches = await fixer.detect({ fileName: fixer.appliesTo, ast: reAst, raw: fixed });
      expect(matches).toEqual([]);
    }
  });
});
