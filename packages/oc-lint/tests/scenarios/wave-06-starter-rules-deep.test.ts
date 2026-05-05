/**
 * Wave 6 — starter-v0 deep dive.
 *
 * Per-rule positive + negative cases beyond the smoke tests in
 * `tests/extensions/oclint-rules-starter/rules.test.ts`.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { STARTER_RULES_V0 } from '../../src/extensions/oclint-rules-starter/index.js';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';

const file = (name: string, raw: string): LintFile => ({
  name,
  ast: parseMd(raw).ast,
});

const idsFromRun = (
  fileName: string,
  raw: string,
): readonly string[] => {
  const r = runLint({ rules: STARTER_RULES_V0, files: [file(fileName, raw)] });
  return r.diagnostics.map((d) => d.ruleId);
};

describe('wave-06 starter-rules deep dive', () => {
  // ---- agents/empty-tools-section ---------------------------------------

  it('CR-01 empty-tools-section: detected when ## Tools has no items', () => {
    expect(idsFromRun('AGENTS.md', '## Tools\n')).toContain(
      'starter-v0/agents/empty-tools-section',
    );
  });

  it('CR-02 empty-tools-section: NOT detected when Tools missing entirely', () => {
    expect(idsFromRun('AGENTS.md', '## Boundaries\n- a\n')).not.toContain(
      'starter-v0/agents/empty-tools-section',
    );
  });

  it('CR-03 empty-tools-section: NOT detected when Tools has plain bullets', () => {
    expect(idsFromRun('AGENTS.md', '## Tools\n- gh\n## Boundaries\n- a\n')).not.toContain(
      'starter-v0/agents/empty-tools-section',
    );
  });

  // ---- agents/missing-boundaries ---------------------------------------

  it('CR-04 missing-boundaries: detected when no ## Boundaries', () => {
    expect(idsFromRun('AGENTS.md', '## Tools\n- gh\n')).toContain(
      'starter-v0/agents/missing-boundaries',
    );
  });

  it('CR-05 missing-boundaries: NOT detected on case variants (slug-fold)', () => {
    expect(idsFromRun('AGENTS.md', '## boundaries\n- never write\n')).not.toContain(
      'starter-v0/agents/missing-boundaries',
    );
    expect(idsFromRun('AGENTS.md', '## BOUNDARIES\n- never\n')).not.toContain(
      'starter-v0/agents/missing-boundaries',
    );
  });

  // ---- agents/duplicate-tool-key ---------------------------------------

  it('CR-06 duplicate-tool-key: case-insensitive match (gh vs GH)', () => {
    const ids = idsFromRun(
      'AGENTS.md',
      '## Tools\n- gh: GitHub\n- GH: dup case\n## Boundaries\n- a\n',
    );
    expect(ids).toContain('starter-v0/agents/duplicate-tool-key');
  });

  it('CR-07 duplicate-tool-key: NOT triggered for distinct keys', () => {
    expect(
      idsFromRun(
        'AGENTS.md',
        '## Tools\n- gh: GitHub\n- curl: HTTP\n- rg: ripgrep\n## Boundaries\n- a\n',
      ),
    ).not.toContain('starter-v0/agents/duplicate-tool-key');
  });

  it('CR-08 duplicate-tool-key: works on plain (non-kv) bullets via slug', () => {
    // Two plain bullets with the same slugified text should still flag.
    const ids = idsFromRun(
      'AGENTS.md',
      '## Tools\n- the same tool\n- the same tool\n## Boundaries\n- a\n',
    );
    expect(ids).toContain('starter-v0/agents/duplicate-tool-key');
  });

  // ---- tools/empty-guidance-table --------------------------------------

  it('CR-09 empty-guidance-table: detected when table has only header', () => {
    expect(
      idsFromRun('TOOLS.md', '## Tool Guidance\n\n| t | g |\n| - | - |\n'),
    ).toContain('starter-v0/tools/empty-guidance-table');
  });

  it('CR-10 empty-guidance-table: NOT detected when table has rows', () => {
    expect(
      idsFromRun('TOOLS.md', '## Tool Guidance\n\n| t | g |\n| - | - |\n| gh | use |\n'),
    ).not.toContain('starter-v0/tools/empty-guidance-table');
  });

  it('CR-11 empty-guidance-table: NOT detected when section missing entirely', () => {
    // The rule checks the table inside a present section; no section
    // means the rule doesn't fire (a different rule would handle that).
    expect(idsFromRun('TOOLS.md', '## Other Section\nbody\n')).not.toContain(
      'starter-v0/tools/empty-guidance-table',
    );
  });

  // ---- memory/missing-frontmatter-scope --------------------------------

  it('CR-12 missing-scope: detected when frontmatter absent', () => {
    expect(idsFromRun('MEMORY.md', '## Entry\nbody\n')).toContain(
      'starter-v0/memory/missing-frontmatter-scope',
    );
  });

  it('CR-13 missing-scope: detected when frontmatter present but no scope key', () => {
    expect(
      idsFromRun('MEMORY.md', '---\nother: value\n---\n## Entry\nbody\n'),
    ).toContain('starter-v0/memory/missing-frontmatter-scope');
  });

  // ---- memory/invalid-scope-value --------------------------------------

  it('CR-14 invalid-scope: detected for outside-enum value', () => {
    expect(idsFromRun('MEMORY.md', '---\nscope: globalish\n---\n## Entry\n')).toContain(
      'starter-v0/memory/invalid-scope-value',
    );
  });

  it('CR-15 invalid-scope: NOT detected for default/global/project/session', () => {
    // Vocabulary aligned with `STARTER_ALLOWED_MEMORY_SCOPES` (the
    // shared starter-pack value set, see C1).
    for (const v of ['default', 'global', 'project', 'session']) {
      expect(
        idsFromRun('MEMORY.md', `---\nscope: ${v}\n---\n## Entry\n`),
      ).not.toContain('starter-v0/memory/invalid-scope-value');
    }
  });

  it('CR-16 invalid-scope: case-sensitive (Project ≠ project)', () => {
    // Documenting policy: scope values are case-sensitive.
    expect(idsFromRun('MEMORY.md', '---\nscope: Project\n---\n## Entry\n')).toContain(
      'starter-v0/memory/invalid-scope-value',
    );
  });

  // ---- skill/missing-required-frontmatter ------------------------------

  it('CR-17 missing-required-frontmatter: 2 findings when both name + description absent', () => {
    const r = runLint({
      rules: STARTER_RULES_V0,
      files: [file('SKILL.md', '---\ntier: T1\n---\n')],
    });
    const matches = r.diagnostics.filter(
      (d) => d.ruleId === 'starter-v0/skill/missing-required-frontmatter',
    );
    expect(matches.length).toBe(2);
  });

  it('CR-18 missing-required-frontmatter: 1 finding when only one absent', () => {
    const r = runLint({
      rules: STARTER_RULES_V0,
      files: [file('SKILL.md', '---\nname: x\n---\n')],
    });
    const matches = r.diagnostics.filter(
      (d) => d.ruleId === 'starter-v0/skill/missing-required-frontmatter',
    );
    expect(matches.length).toBe(1);
    expect(matches[0]?.message).toContain('description');
  });

  it('CR-19 missing-required-frontmatter: 0 findings when both present', () => {
    expect(
      idsFromRun('SKILL.md', '---\nname: x\ndescription: y\n---\n'),
    ).not.toContain('starter-v0/skill/missing-required-frontmatter');
  });

  // ---- skill/invalid-tier-value ----------------------------------------

  it('CR-20 invalid-tier: T0/T4/lowercase rejected', () => {
    for (const v of ['T0', 'T4', 't1', 'tier-a']) {
      expect(
        idsFromRun('SKILL.md', `---\nname: x\ndescription: y\ntier: ${v}\n---\n`),
      ).toContain('starter-v0/skill/invalid-tier-value');
    }
  });

  it('CR-21 invalid-tier: NOT triggered when tier absent', () => {
    expect(
      idsFromRun('SKILL.md', '---\nname: x\ndescription: y\n---\n'),
    ).not.toContain('starter-v0/skill/invalid-tier-value');
  });

  // ---- identity/missing-trust-level ------------------------------------

  it('CR-22 missing-trust-level: case-insensitive section slug match', () => {
    expect(
      idsFromRun('IDENTITY.md', '## Trust Level\ntrusted\n'),
    ).not.toContain('starter-v0/identity/missing-trust-level');
    expect(
      idsFromRun('IDENTITY.md', '## TRUST LEVEL\ntrusted\n'),
    ).not.toContain('starter-v0/identity/missing-trust-level');
  });

  // ---- user/missing-preferences-section --------------------------------

  it('CR-23 missing-preferences: detected when section absent', () => {
    expect(idsFromRun('USER.md', '## Role\nPM\n')).toContain(
      'starter-v0/user/missing-preferences-section',
    );
  });

  it('CR-24 missing-preferences: NOT detected when present (case variants)', () => {
    expect(idsFromRun('USER.md', '## Preferences\n- async\n')).not.toContain(
      'starter-v0/user/missing-preferences-section',
    );
    expect(idsFromRun('USER.md', '## PREFERENCES\n- async\n')).not.toContain(
      'starter-v0/user/missing-preferences-section',
    );
  });

  // ---- cross-rule sanity ------------------------------------------------

  it('CR-25 a rule applied to wrong file does NOT fire', () => {
    // agents/empty-tools-section targets AGENTS.md only; running against
    // SOUL.md should never produce that diagnostic, even with empty Tools.
    expect(idsFromRun('SOUL.md', '## Tools\n')).not.toContain(
      'starter-v0/agents/empty-tools-section',
    );
  });

  it('CR-26 BOOTSTRAP.md gets zero starter-v0 diagnostics (no rule targets it)', () => {
    expect(idsFromRun('BOOTSTRAP.md', '## Setup\n- a\n').length).toBe(0);
  });

  it('CR-27 every rule emits a diagnostic with line ≥ 1', () => {
    const r = runLint({
      rules: STARTER_RULES_V0,
      files: [
        file('AGENTS.md', '## Tools\n'),
        file('MEMORY.md', '## Entry\n'),
        file('SKILL.md', '---\ntier: T7\n---\n'),
        file('IDENTITY.md', '## Org\n'),
        file('USER.md', '## Role\n'),
      ],
    });
    for (const d of r.diagnostics) {
      expect(d.line).toBeGreaterThanOrEqual(1);
    }
  });

  it('CR-28 every emitted diagnostic carries fixHint', () => {
    const r = runLint({
      rules: STARTER_RULES_V0,
      files: [
        file('AGENTS.md', '## Tools\n'),
        file('MEMORY.md', '## Entry\n'),
        file('SKILL.md', '---\n---\n'),
        file('IDENTITY.md', '## Org\n'),
        file('USER.md', '## Role\n'),
      ],
    });
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.fixHint, `${d.ruleId} missing fixHint`).toBeDefined();
    }
  });
});
