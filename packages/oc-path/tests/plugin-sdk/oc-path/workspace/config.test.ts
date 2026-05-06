/**
 * Unit tests for the generic `workspace.json` loader + glob
 * primitives. Section-specific resolvers (lint / doctor / lkg /
 * policy) live in their consuming substrate packages.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceConfigError,
  filterByOnlyGlobs,
  loadWorkspaceConfig,
  matchRuleIdGlob,
} from '../../../../src/plugin-sdk/oc-path/workspace/config.js';

describe('loadWorkspaceConfig', () => {
  it('LWC-01 returns null when workspace.json is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-empty-'));
    const cfg = await loadWorkspaceConfig(dir);
    expect(cfg).toBeNull();
  });

  it('LWC-02 parses a minimal `{}` config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-empty-config-'));
    writeFileSync(join(dir, 'workspace.json'), '{}', 'utf-8');
    const cfg = await loadWorkspaceConfig(dir);
    expect(cfg).toEqual({});
  });

  it('LWC-03 returns the raw object — opaque, additive, no schema validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-additive-'));
    const body = {
      lint: { skip: ['x'] },
      futureSection: { foo: 'bar' },
      lkg: { skip: ['session.jsonl'] },
    };
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify(body), 'utf-8');
    const cfg = await loadWorkspaceConfig(dir);
    expect(cfg).toEqual(body);
    // Cast-and-read pattern: each consumer reads its own section.
    expect((cfg?.['lint'] as { skip?: string[] } | undefined)?.skip).toEqual(['x']);
    expect((cfg?.['futureSection'] as { foo?: string } | undefined)?.foo).toBe('bar');
  });

  it('LWC-04 throws on malformed input with a useful message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-bad-'));
    writeFileSync(join(dir, 'workspace.json'), '{ this is not valid', 'utf-8');
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/parse failed/);
  });

  it('LWC-05 accepts JSONC syntax (comments + trailing commas)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-jsonc-'));
    const body = `// pinch lint config — operator notes
{
  "lint": {
    "skip": [
      "starter-v0/agents/missing-boundaries", // noisy in this repo
      /* will revisit when we pick a severity story */
      "lkg-starter-v0/lkg/empty-tracked-file",
    ],
  },
}`;
    writeFileSync(join(dir, 'workspace.json'), body, 'utf-8');
    const cfg = await loadWorkspaceConfig(dir);
    expect((cfg?.['lint'] as { skip?: string[] } | undefined)?.skip).toEqual([
      'starter-v0/agents/missing-boundaries',
      'lkg-starter-v0/lkg/empty-tracked-file',
    ]);
  });

  it('LWC-06 returns {} on empty / whitespace-only file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-empty-bytes-'));
    writeFileSync(join(dir, 'workspace.json'), '   \n\n   ', 'utf-8');
    const cfg = await loadWorkspaceConfig(dir);
    expect(cfg).toEqual({});
  });

  it('LWC-07 throws when root is not an object (e.g., array)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-array-'));
    writeFileSync(join(dir, 'workspace.json'), '[1, 2, 3]', 'utf-8');
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/object at the root/);
  });

  it('LWC-08 parse failure throws WorkspaceConfigError with WORKSPACE_CONFIG_PARSE_FAILED code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-typed-parse-'));
    writeFileSync(join(dir, 'workspace.json'), '{ this is not valid', 'utf-8');
    await expect(loadWorkspaceConfig(dir)).rejects.toMatchObject({
      name: 'WorkspaceConfigError',
      code: 'WORKSPACE_CONFIG_PARSE_FAILED',
    });
    await expect(loadWorkspaceConfig(dir)).rejects.toBeInstanceOf(WorkspaceConfigError);
  });

  it('LWC-09 not-an-object throws WorkspaceConfigError with WORKSPACE_CONFIG_NOT_OBJECT code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsc-typed-array-'));
    writeFileSync(join(dir, 'workspace.json'), '[1, 2, 3]', 'utf-8');
    await expect(loadWorkspaceConfig(dir)).rejects.toMatchObject({
      name: 'WorkspaceConfigError',
      code: 'WORKSPACE_CONFIG_NOT_OBJECT',
    });
  });
});

describe('matchRuleIdGlob', () => {
  it('MGR-01 exact match', () => {
    expect(matchRuleIdGlob('a/b/c', 'a/b/c')).toBe(true);
    expect(matchRuleIdGlob('a/b/c', 'a/b/d')).toBe(false);
  });

  it('MGR-02 wildcard `*`', () => {
    expect(matchRuleIdGlob('a/b/*', 'a/b/c')).toBe(true);
    expect(matchRuleIdGlob('a/b/*', 'a/b/anything-here')).toBe(true);
    expect(matchRuleIdGlob('a/b/*', 'a/c/x')).toBe(false);
  });

  it('MGR-03 namespace prefix glob', () => {
    expect(matchRuleIdGlob('starter-v0/*', 'starter-v0/agents/foo')).toBe(true);
    expect(matchRuleIdGlob('starter-v0/*', 'policy-starter-v0/foo')).toBe(false);
  });

  it('MGR-04 alternation `{a,b,c}`', () => {
    expect(matchRuleIdGlob('{a,b}/x', 'a/x')).toBe(true);
    expect(matchRuleIdGlob('{a,b}/x', 'b/x')).toBe(true);
    expect(matchRuleIdGlob('{a,b}/x', 'c/x')).toBe(false);
  });

  it('MGR-05 special chars in rule ids escaped properly', () => {
    expect(matchRuleIdGlob('a.b/c', 'a.b/c')).toBe(true);
    expect(matchRuleIdGlob('a.b/c', 'aXb/c')).toBe(false); // `.` not regex
  });
});

describe('filterByOnlyGlobs', () => {
  const ITEMS = [
    { id: 'starter-v0/agents/missing-boundaries' },
    { id: 'policy-starter-v0/tools/missing-risk-level' },
    { id: 'lkg-starter-v0/lkg/sentinel-in-content' },
  ];

  it('FBOG-01 empty globs returns input unchanged', () => {
    expect(filterByOnlyGlobs(ITEMS, [])).toBe(ITEMS);
  });

  it('FBOG-02 single-glob filter narrows to matching prefix', () => {
    const result = filterByOnlyGlobs(ITEMS, ['policy-starter-v0/*']);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('policy-starter-v0/tools/missing-risk-level');
  });

  it('FBOG-03 multi-glob filter is union (any match)', () => {
    const result = filterByOnlyGlobs(ITEMS, [
      'policy-starter-v0/*',
      'lkg-starter-v0/*',
    ]);
    expect(result).toHaveLength(2);
  });
});
