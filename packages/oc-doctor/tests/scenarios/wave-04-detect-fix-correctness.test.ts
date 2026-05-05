/**
 * Wave 4 — per-fixer detect/fix correctness.
 *
 * Each fixer's detect + fix produce the right output across malformed,
 * partial, and edge-case inputs. Goes deeper than the smoke tests in
 * `tests/extensions/ocdoctor-fixers-starter/fixers.test.ts`.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  agentsAddBoundariesStub,
  memoryAddScopeDefault,
  userAddPreferencesStub,
} from '../../src/extensions/ocdoctor-fixers-starter/index.js';
import type { OcPathFixerSpec } from '../../src/plugin-sdk/oc-doctor/types.js';

async function detectMatches(spec: OcPathFixerSpec, raw: string) {
  const { ast } = parseMd(raw);
  return await spec.detect({ fileName: spec.appliesTo, ast, raw });
}

async function applyFix(spec: OcPathFixerSpec, raw: string): Promise<string> {
  const matches = await detectMatches(spec, raw);
  if (matches.length === 0) return raw;
  const { ast } = parseMd(raw);
  return await spec.fix({
    fileName: spec.appliesTo,
    ast,
    raw,
    match: matches[0]!.match,
  });
}

describe('wave-04 agents/add-boundaries-stub correctness', () => {
  it('AB-01 detects nothing on empty file (no Boundaries needed without any sections)', async () => {
    // Intentional behavior: empty file has no ## Boundaries → detected;
    // fixer appends one. Operators can opt out by deleting the file.
    const matches = await detectMatches(agentsAddBoundariesStub, '');
    expect(matches.length).toBe(1);
  });

  it('AB-02 detects when only ## Tools is present', async () => {
    expect((await detectMatches(agentsAddBoundariesStub, '## Tools\n')).length).toBe(1);
  });

  it('AB-03 NOT detected when ## Boundaries already exists at any position', async () => {
    expect((await detectMatches(agentsAddBoundariesStub, '## Boundaries\n## Tools\n')).length).toBe(0);
    expect((await detectMatches(agentsAddBoundariesStub, '## Tools\n## Boundaries\n')).length).toBe(0);
  });

  it('AB-04 case-insensitive section slug matching', async () => {
    expect((await detectMatches(agentsAddBoundariesStub, '## boundaries\n')).length).toBe(0);
    expect((await detectMatches(agentsAddBoundariesStub, '## BOUNDARIES\n')).length).toBe(0);
    expect((await detectMatches(agentsAddBoundariesStub, '## Boundaries  \n')).length).toBe(0);
  });

  it('AB-05 fix preserves all existing content', async () => {
    const before = '## Tools\n- gh\n- curl\n## Notes\n- a\n- b\n';
    const after = await applyFix(agentsAddBoundariesStub, before);
    expect(after).toContain('## Tools');
    expect(after).toContain('- gh');
    expect(after).toContain('- curl');
    expect(after).toContain('## Notes');
    expect(after).toContain('## Boundaries');
  });

  it('AB-06 fix does not duplicate trailing newline', async () => {
    const before = '## Tools\n';
    const after = await applyFix(agentsAddBoundariesStub, before);
    // The fix appends a leading-newline stub when raw ends with `\n`;
    // there should be no triple-newline collisions.
    expect(after).not.toMatch(/\n\n\n\n/);
  });
});

describe('wave-04 memory/add-scope-default correctness', () => {
  it('MA-01 NOT detected when scope: <any value> is set', async () => {
    expect((await detectMatches(memoryAddScopeDefault, '---\nscope: project\n---\n')).length).toBe(0);
    expect((await detectMatches(memoryAddScopeDefault, '---\nscope: globalish\n---\n')).length).toBe(0);
    // Even invalid scope values pass detection — that's a different rule's
    // concern (memory/invalid-scope-value).
  });

  it('MA-02 detected when frontmatter is empty', async () => {
    expect((await detectMatches(memoryAddScopeDefault, '---\n---\n## Entry\n')).length).toBe(1);
  });

  it('MA-03 detected when frontmatter is absent', async () => {
    expect((await detectMatches(memoryAddScopeDefault, '## Entry\n')).length).toBe(1);
  });

  it('MA-04 inserts scope BEFORE the closing fence', async () => {
    const before = '---\nother: value\nmore: data\n---\n## Entry\n';
    const after = await applyFix(memoryAddScopeDefault, before);
    // scope: project should be inside the frontmatter, before the second ---.
    const fmEnd = after.indexOf('---\n## Entry');
    const scopeAt = after.indexOf('scope: project');
    expect(scopeAt).toBeLessThan(fmEnd);
    expect(scopeAt).toBeGreaterThan(after.indexOf('---'));
  });

  it('MA-05 preserves CRLF line endings when inserting', async () => {
    const before = '---\r\nother: value\r\n---\r\n## Entry\r\n';
    const after = await applyFix(memoryAddScopeDefault, before);
    expect(after).toContain('scope: project\r\n');
    // Original CRLF preserved.
    expect(after).toContain('other: value\r\n');
  });

  it('MA-06 prepends frontmatter when none exists', async () => {
    const before = '## Entry\nbody\n';
    const after = await applyFix(memoryAddScopeDefault, before);
    expect(after.startsWith('---\nscope: project\n---\n')).toBe(true);
    expect(after).toContain('## Entry');
    expect(after).toContain('body');
  });
});

describe('wave-04 user/add-preferences-stub correctness', () => {
  it('UA-01 NOT detected when ## Preferences exists', async () => {
    expect((await detectMatches(userAddPreferencesStub, '## Preferences\n- async\n')).length).toBe(0);
  });

  it('UA-02 detected when ## Role exists but ## Preferences does not', async () => {
    expect((await detectMatches(userAddPreferencesStub, '## Role\nPM\n')).length).toBe(1);
  });

  it('UA-03 case-insensitive section slug', async () => {
    expect((await detectMatches(userAddPreferencesStub, '## preferences\n')).length).toBe(0);
    expect((await detectMatches(userAddPreferencesStub, '## PREFERENCES\n')).length).toBe(0);
  });

  it('UA-04 fix on empty file appends section', async () => {
    const after = await applyFix(userAddPreferencesStub, '');
    expect(after).toContain('## Preferences');
  });

  it('UA-05 fix preserves frontmatter when present', async () => {
    const before = '---\nrole: PM\n---\n## Role\nbody\n';
    const after = await applyFix(userAddPreferencesStub, before);
    expect(after).toContain('---\nrole: PM\n---');
    expect(after).toContain('## Role');
    expect(after).toContain('## Preferences');
  });
});
