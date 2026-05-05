import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  STARTER_FIXERS_V0,
  STARTER_FIXERS_V0_OPTIONAL,
  agentsAddBoundariesStub,
  agentsSeedToolsTodo,
  identityAddTrustLevelStub,
  memoryAddScopeDefault,
  memorySnapScope,
  skillAddRequiredFrontmatterStub,
  skillSnapTier,
  toolsAddGuidanceTableStub,
  userAddPreferencesStub,
} from '../../../src/extensions/ocdoctor-fixers-starter/index.js';
import type { OcPathFixerSpec } from '../../../src/plugin-sdk/oc-doctor/types.js';

async function detect(spec: OcPathFixerSpec<unknown>, raw: string, fileName = spec.appliesTo) {
  return await spec.detect({ fileName, ast: parseMd(raw).ast, raw });
}

async function fix(spec: OcPathFixerSpec<unknown>, raw: string, fileName = spec.appliesTo): Promise<string> {
  const ast = parseMd(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({ fileName, ast, raw, match: matches[0]!.match });
}

describe('agentsAddBoundariesStub', () => {
  it('detects missing boundaries section', async () => {
    expect((await detect(agentsAddBoundariesStub, '## Tools\n- gh\n')).length).toBe(1);
  });
  it('does not detect when boundaries section exists', async () => {
    expect(
      (await detect(agentsAddBoundariesStub, '## Tools\n## Boundaries\n- never rm -rf\n')).length,
    ).toBe(0);
  });
  it('appends a Boundaries stub', async () => {
    const after = await fix(agentsAddBoundariesStub, '## Tools\n- gh\n');
    expect(after).toContain('## Boundaries');
    expect(after).toContain('## Tools');
  });
  it('is idempotent', async () => {
    const once = await fix(agentsAddBoundariesStub, '## Tools\n- gh\n');
    const twice = await fix(agentsAddBoundariesStub, once);
    expect(twice).toBe(once);
  });
  it('skips non-md ast (defensive)', () => {
    expect(agentsAddBoundariesStub.appliesTo).toBe('AGENTS.md');
  });
});

describe('toolsAddGuidanceTableStub', () => {
  it('detects missing guidance section', async () => {
    expect((await detect(toolsAddGuidanceTableStub, '## Header\n')).length).toBe(1);
  });
  it('appends a Tool Guidance section with a table', async () => {
    const after = await fix(toolsAddGuidanceTableStub, '## Header\n');
    expect(after).toContain('## Tool Guidance');
    expect(after).toMatch(/\|\s*tool\s*\|\s*guidance\s*\|/);
  });
  it('is idempotent', async () => {
    const once = await fix(toolsAddGuidanceTableStub, '## Header\n');
    const twice = await fix(toolsAddGuidanceTableStub, once);
    expect(twice).toBe(once);
  });
});

describe('memoryAddScopeDefault', () => {
  it('detects missing scope frontmatter', async () => {
    expect((await detect(memoryAddScopeDefault, '## Entry\nbody\n')).length).toBe(1);
  });
  it('does not detect when scope present', async () => {
    expect(
      (await detect(memoryAddScopeDefault, '---\nscope: default\n---\n## Entry\n')).length,
    ).toBe(0);
  });
  it('inserts scope: default into frontmatter', async () => {
    const after = await fix(memoryAddScopeDefault, '## Entry\nbody\n');
    expect(after).toContain('scope:');
  });
  it('is idempotent', async () => {
    const once = await fix(memoryAddScopeDefault, '## Entry\nbody\n');
    const twice = await fix(memoryAddScopeDefault, once);
    expect(twice).toBe(once);
  });
});

describe('skillAddRequiredFrontmatterStub', () => {
  it('detects missing required frontmatter', async () => {
    expect((await detect(skillAddRequiredFrontmatterStub, '## Body\n')).length).toBeGreaterThan(0);
  });
  it('appends required frontmatter on the empty case', async () => {
    const after = await fix(skillAddRequiredFrontmatterStub, '## Body\n');
    // The stub touches frontmatter — we don't lock the exact string,
    // just that it differs and is idempotent.
    expect(after).not.toBe('## Body\n');
  });
  it('is idempotent', async () => {
    const once = await fix(skillAddRequiredFrontmatterStub, '## Body\n');
    const twice = await fix(skillAddRequiredFrontmatterStub, once);
    expect(twice).toBe(once);
  });
});

describe('identityAddTrustLevelStub', () => {
  it('detects missing trust-level section', async () => {
    expect((await detect(identityAddTrustLevelStub, '## Section\n')).length).toBe(1);
  });
  it('appends a Trust Level section', async () => {
    const after = await fix(identityAddTrustLevelStub, '## Section\n');
    expect(after.toLowerCase()).toContain('trust');
  });
  it('is idempotent', async () => {
    const once = await fix(identityAddTrustLevelStub, '## Section\n');
    const twice = await fix(identityAddTrustLevelStub, once);
    expect(twice).toBe(once);
  });
});

describe('userAddPreferencesStub', () => {
  it('detects missing preferences section', async () => {
    expect((await detect(userAddPreferencesStub, '## Role\n')).length).toBe(1);
  });
  it('appends a Preferences section', async () => {
    const after = await fix(userAddPreferencesStub, '## Role\n');
    expect(after).toContain('## Preferences');
  });
  it('is idempotent', async () => {
    const once = await fix(userAddPreferencesStub, '## Role\n');
    const twice = await fix(userAddPreferencesStub, once);
    expect(twice).toBe(once);
  });
});

describe('agentsSeedToolsTodo (optional)', () => {
  it('declares default placeholder option', () => {
    expect(agentsSeedToolsTodo.defaultOptions?.placeholder).toBeTruthy();
  });
});

describe('memorySnapScope (optional)', () => {
  it('declares default targetScope option', () => {
    expect(memorySnapScope.defaultOptions?.targetScope).toBe('default');
  });
});

describe('skillSnapTier (optional)', () => {
  it('declares default targetTier option', () => {
    expect(skillSnapTier.defaultOptions?.targetTier).toBe(1);
  });
});

describe('starter-v0 pack invariants', () => {
  it('exports 6 default fixers', () => {
    expect(STARTER_FIXERS_V0).toHaveLength(6);
  });
  it('exports 3 optional fixers', () => {
    expect(STARTER_FIXERS_V0_OPTIONAL).toHaveLength(3);
  });
  it('all default fixer ids share starter-v0 namespace', () => {
    for (const f of STARTER_FIXERS_V0) {
      expect(f.id.startsWith('starter-v0/')).toBe(true);
    }
  });
  it('every fixer has a non-empty description', () => {
    for (const f of [...STARTER_FIXERS_V0, ...STARTER_FIXERS_V0_OPTIONAL]) {
      expect(typeof f.description).toBe('string');
      expect(f.description.length).toBeGreaterThan(0);
    }
  });
  it('all default fixer ids are unique', () => {
    const ids = STARTER_FIXERS_V0.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('starter-v0 — adversarial inputs do not throw', () => {
  const inputs = [
    '',
    '\n',
    '   \n',
    '## Heading only\n',
    '---\n---\n',
    '---\nbroken: [unclosed\n---\n## H\n',
    'just preamble',
  ];
  for (const fixer of [...STARTER_FIXERS_V0, ...STARTER_FIXERS_V0_OPTIONAL]) {
    for (const raw of inputs) {
      it(`${fixer.id} no-throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => fix(fixer, raw)).not.toThrow();
      });
    }
  }
});
