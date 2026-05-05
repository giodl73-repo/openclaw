/**
 * Wave 6 — stress + ordering determinism.
 *
 * Doctor pack runs deterministically across many invocations and large
 * workspaces. Adapter dispatch order is stable; writeFile is called the
 * same number of times for the same input.
 */
import { describe, expect, it } from 'vitest';
import { STARTER_FIXERS_V0_CONTRIBUTIONS } from '../../src/extensions/ocdoctor-fixers-starter/index.js';
import type { DoctorContext, DoctorFinding } from '../../src/plugin-sdk/oc-doctor/types.js';
import { makeDoctorFile } from '../test-helpers.js';

function ctxOf(files: { name: string; raw: string }[]): {
  ctx: DoctorContext;
  writes: Map<string, string>;
} {
  const writes = new Map<string, string>();
  return {
    writes,
    ctx: {
      workspaceDir: '/ws',
      files: files.map((f, i) => makeDoctorFile(f.name, `/ws/${i}-${f.name}`, f.raw)),
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    },
  };
}

describe('wave-06 stress-ordering', () => {
  it('SO-01 STARTER_FIXERS_V0_CONTRIBUTIONS exports 6 contributions in stable order', () => {
    expect(STARTER_FIXERS_V0_CONTRIBUTIONS.length).toBe(6);
    const ids = STARTER_FIXERS_V0_CONTRIBUTIONS.map((c) => c.id);
    expect(ids).toEqual([
      'starter-v0/agents/add-boundaries-stub',
      'starter-v0/tools/add-guidance-table-stub',
      'starter-v0/memory/add-scope-default',
      'starter-v0/skill/add-required-frontmatter-stub',
      'starter-v0/identity/add-trust-level-stub',
      'starter-v0/user/add-preferences-stub',
    ]);
  });

  it('SO-02 detect across 100 files completes quickly', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      name: (i % 3 === 0 ? 'AGENTS.md' : i % 3 === 1 ? 'MEMORY.md' : 'USER.md') as
        | 'AGENTS.md'
        | 'MEMORY.md'
        | 'USER.md',
      raw: `## Section ${i}\n`,
    }));
    const m = ctxOf(files);
    const start = performance.now();
    for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) {
      await c.detect(m.ctx);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('SO-03 fix on 100 files produces 100 writes with unique paths', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      name: 'AGENTS.md' as const,
      raw: `## Section ${i}\n`,
    }));
    const m = ctxOf(files);
    const c = STARTER_FIXERS_V0_CONTRIBUTIONS[0]!;
    const findings = await c.detect(m.ctx);
    expect(findings.length).toBe(100);
    for (const f of findings) {
      await c.fix(m.ctx, f);
    }
    expect(m.writes.size).toBe(100);
  });

  it('SO-04 detect output is deterministic across multiple invocations', async () => {
    const m = ctxOf([
      { name: 'AGENTS.md', raw: '## Tools\n' },
      { name: 'MEMORY.md', raw: '## Entry\n' },
      { name: 'USER.md', raw: '## Role\n' },
    ]);
    const r1: DoctorFinding[] = [];
    for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) r1.push(...(await c.detect(m.ctx)));
    const r2: DoctorFinding[] = [];
    for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) r2.push(...(await c.detect(m.ctx)));
    expect(r1.map((f) => f.contributionId)).toEqual(r2.map((f) => f.contributionId));
  });

  it('SO-05 fix is non-mutating with respect to ctx.files', async () => {
    const m = ctxOf([{ name: 'AGENTS.md', raw: '## Tools\n' }]);
    const c = STARTER_FIXERS_V0_CONTRIBUTIONS[0]!;
    const before = JSON.stringify(m.ctx.files);
    const findings = await c.detect(m.ctx);
    await c.fix(m.ctx, findings[0]!);
    const after = JSON.stringify(m.ctx.files);
    expect(after).toBe(before);
  });

  it('SO-06 detect skips files whose name does not match any spec', async () => {
    // None of the 6 starter fixers target SOUL.md, HEARTBEAT.md, or
    // BOOTSTRAP.md — all 6 contributions detect zero findings on these.
    const m = ctxOf([
      { name: 'SOUL.md', raw: '## H\n' },
      { name: 'HEARTBEAT.md', raw: '## H\n' },
      { name: 'BOOTSTRAP.md', raw: '## H\n' },
    ]);
    for (const c of STARTER_FIXERS_V0_CONTRIBUTIONS) {
      const findings = await c.detect(m.ctx);
      expect(findings).toEqual([]);
    }
  });

  it('SO-07 multiple contributions can run concurrently without state leakage', async () => {
    // One file per fixer's target — each contribution detects exactly
    // one finding from its paired file.
    const m = ctxOf([
      { name: 'AGENTS.md', raw: '## Tools\n' },
      { name: 'TOOLS.md', raw: '## Other\n' },
      { name: 'MEMORY.md', raw: '## Entry\n' },
      { name: 'SKILL.md', raw: '---\ntier: T1\n---\n' },
      { name: 'IDENTITY.md', raw: '## Org\n' },
      { name: 'USER.md', raw: '## Role\n' },
    ]);
    const all = await Promise.all(
      STARTER_FIXERS_V0_CONTRIBUTIONS.map((c) => c.detect(m.ctx)),
    );
    // Each contribution should detect at least one finding from its
    // paired file. Skill fixer detects two findings (name + description
    // both missing); the others detect one each.
    for (const findings of all) {
      expect(findings.length).toBeGreaterThanOrEqual(1);
    }
  });

});
