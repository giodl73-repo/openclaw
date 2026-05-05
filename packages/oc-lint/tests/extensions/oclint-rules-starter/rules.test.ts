/**
 * starter-v0 starter pack — one test per rule, plus an integration
 * test that runs the full pack against the substrate fixtures and
 * verifies expected diagnostic shape.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  STARTER_RULES_V0,
  registerStarterRulesV0,
} from '../../../src/extensions/oclint-rules-starter/index.js';
import { LintRuleRegistry, runLint } from '../../../src/oc-lint/index.js';
import type { LintFile } from '../../../src/oc-lint/runner.js';

function file(name: LintFile['name'], raw: string): LintFile {
  return { name, ast: parseMd(raw).ast };
}

describe('starter-v0 starter pack', () => {
  it('exports exactly 10 rules at info severity', () => {
    expect(STARTER_RULES_V0.length).toBe(10);
    for (const r of STARTER_RULES_V0) {
      expect(r.severity).toBe('info');
    }
  });

  it('all rule ids are namespaced under starter-v0/', () => {
    for (const r of STARTER_RULES_V0) {
      expect(r.id.startsWith('starter-v0/')).toBe(true);
    }
  });

  it('all rule ids are unique', () => {
    const ids = STARTER_RULES_V0.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registerStarterRulesV0 wires every rule into a registry', () => {
    const reg = new LintRuleRegistry();
    registerStarterRulesV0((rule) => reg.register(rule));
    expect(reg.size()).toBe(10);
  });

  // ---- per-rule behavior tests ------------------------------------------

  it('agents/empty-tools-section: flags empty Tools section', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('AGENTS.md', '## Tools\n\n## Boundaries\n- a\n')],
    });
    expect(
      result.diagnostics.some((d) => d.ruleId === 'starter-v0/agents/empty-tools-section'),
    ).toBe(true);
  });

  it('agents/empty-tools-section: passes when Tools has items', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('AGENTS.md', '## Tools\n- gh: GitHub CLI\n## Boundaries\n- a\n')],
    });
    expect(
      result.diagnostics.some((d) => d.ruleId === 'starter-v0/agents/empty-tools-section'),
    ).toBe(false);
  });

  it('agents/missing-boundaries: flags AGENTS.md without Boundaries', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('AGENTS.md', '## Tools\n- gh: GitHub\n')],
    });
    expect(
      result.diagnostics.some((d) => d.ruleId === 'starter-v0/agents/missing-boundaries'),
    ).toBe(true);
  });

  it('agents/duplicate-tool-key: flags two items with same kv key', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [
        file('AGENTS.md', '## Tools\n- gh: GitHub\n- gh: dup\n## Boundaries\n- a\n'),
      ],
    });
    const d = result.diagnostics.find(
      (x) => x.ruleId === 'starter-v0/agents/duplicate-tool-key',
    );
    expect(d).toBeDefined();
    expect(d?.message).toContain('duplicate tool key');
  });

  it('tools/empty-guidance-table: flags empty Tool Guidance table', () => {
    const raw = `## Tool Guidance\n\n| tool | guidance |\n| --- | --- |\n`;
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('TOOLS.md', raw)],
    });
    expect(
      result.diagnostics.some((d) => d.ruleId === 'starter-v0/tools/empty-guidance-table'),
    ).toBe(true);
  });

  it('memory/missing-frontmatter-scope: flags MEMORY.md with no scope', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('MEMORY.md', '## Entry\nbody\n')],
    });
    expect(
      result.diagnostics.some(
        (d) => d.ruleId === 'starter-v0/memory/missing-frontmatter-scope',
      ),
    ).toBe(true);
  });

  it('memory/missing-frontmatter-scope: passes with scope set', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('MEMORY.md', '---\nscope: project\n---\n## Entry\n')],
    });
    expect(
      result.diagnostics.some(
        (d) => d.ruleId === 'starter-v0/memory/missing-frontmatter-scope',
      ),
    ).toBe(false);
  });

  it('memory/invalid-scope-value: flags scope outside enum', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('MEMORY.md', '---\nscope: globalish\n---\n## Entry\n')],
    });
    const d = result.diagnostics.find(
      (x) => x.ruleId === 'starter-v0/memory/invalid-scope-value',
    );
    expect(d).toBeDefined();
    expect(d?.message).toContain('globalish');
  });

  it('skill/missing-required-frontmatter: flags missing name/description', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('SKILL.md', '---\ntier: T1\n---\nbody\n')],
    });
    const matches = result.diagnostics.filter(
      (d) => d.ruleId === 'starter-v0/skill/missing-required-frontmatter',
    );
    expect(matches.length).toBe(2); // name + description
  });

  it('skill/invalid-tier-value: flags tier outside T1/T2/T3', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [
        file('SKILL.md', '---\nname: x\ndescription: y\ntier: T4\n---\n'),
      ],
    });
    expect(
      result.diagnostics.some((d) => d.ruleId === 'starter-v0/skill/invalid-tier-value'),
    ).toBe(true);
  });

  it('identity/missing-trust-level: flags IDENTITY.md without Trust Level', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('IDENTITY.md', '## Organization\nMicrosoft\n')],
    });
    expect(
      result.diagnostics.some(
        (d) => d.ruleId === 'starter-v0/identity/missing-trust-level',
      ),
    ).toBe(true);
  });

  it('user/missing-preferences-section: flags USER.md without Preferences', () => {
    const result = runLint({
      rules: STARTER_RULES_V0,
      files: [file('USER.md', '## Role\nPM\n')],
    });
    expect(
      result.diagnostics.some(
        (d) => d.ruleId === 'starter-v0/user/missing-preferences-section',
      ),
    ).toBe(true);
  });

  // ---- integration: clean workspace produces no diagnostics ---------------

  it('a fully-configured workspace produces zero diagnostics from this pack', () => {
    const files: LintFile[] = [
      file(
        'AGENTS.md',
        '## Tools\n- gh: GitHub CLI\n## Boundaries\n- never write to /etc\n',
      ),
      file('TOOLS.md', '## Tool Guidance\n\n| tool | guidance |\n| --- | --- |\n| gh | use |\n'),
      file('MEMORY.md', '---\nscope: project\n---\n## Entry\nbody\n'),
      file('SKILL.md', '---\nname: github\ndescription: gh CLI\ntier: T1\n---\n'),
      file('IDENTITY.md', '## Trust Level\ninternal-trusted\n'),
      file('USER.md', '## Preferences\n- async\n'),
    ];
    const result = runLint({ rules: STARTER_RULES_V0, files });
    expect(result.diagnostics).toEqual([]);
  });

  // ---- integration: malformed workspace produces ALL the warnings -----------

  it('a stub workspace produces the expected diagnostic count', () => {
    const files: LintFile[] = [
      file('AGENTS.md', '## Tools\n'), // empty-tools + missing-boundaries
      file('MEMORY.md', '## Entry\n'), // missing-scope
      file('SKILL.md', '---\ntier: T7\n---\n'), // missing-required (×2) + invalid-tier
      file('IDENTITY.md', '## Org\n'), // missing-trust-level
      file('USER.md', '## Role\n'), // missing-preferences
    ];
    const result = runLint({ rules: STARTER_RULES_V0, files });
    const ids = result.diagnostics.map((d) => d.ruleId);
    expect(ids).toContain('starter-v0/agents/empty-tools-section');
    expect(ids).toContain('starter-v0/agents/missing-boundaries');
    expect(ids).toContain('starter-v0/memory/missing-frontmatter-scope');
    expect(ids).toContain('starter-v0/skill/missing-required-frontmatter');
    expect(ids).toContain('starter-v0/skill/invalid-tier-value');
    expect(ids).toContain('starter-v0/identity/missing-trust-level');
    expect(ids).toContain('starter-v0/user/missing-preferences-section');
  });
});
