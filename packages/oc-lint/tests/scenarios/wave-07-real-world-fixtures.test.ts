/**
 * Wave 7 — real-world fixtures + workspace integration.
 *
 * Run starter-v0 against the substrate's 8-file fixture set and
 * verify expected diagnostic profile.
 */
import { parseMd } from '@openclaw/oc-path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STARTER_RULES_V0 } from '../../src/extensions/oclint-rules-starter/index.js';
import { runLint, type LintFile } from '../../src/oc-lint/runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE_FIXTURES = join(
  HERE,
  '..',
  '..',
  '..',
  'oc-path',
  'tests',
  'fixtures',
  'real',
);

function loadFile(name: string): LintFile {
  const raw = readFileSync(join(SUBSTRATE_FIXTURES, name), 'utf-8');
  return { name, ast: parseMd(raw).ast };
}

describe('wave-07 real-world-fixtures', () => {
  it('RW-01 SOUL.md fixture produces zero diagnostics from starter-v0', () => {
    // No starter-v0 rules target SOUL.md.
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('SOUL.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-02 AGENTS.md fixture has Tools + Boundaries: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('AGENTS.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-03 MEMORY.md fixture has scope: project: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('MEMORY.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-04 TOOLS.md fixture has populated Tool Guidance table: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('TOOLS.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-05 IDENTITY.md fixture has Trust Level: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('IDENTITY.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-06 USER.md fixture has Preferences: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('USER.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-07 SKILL.md fixture has all required frontmatter + valid tier: zero diagnostics', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('SKILL.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-08 HEARTBEAT.md fixture: zero diagnostics (no rules target it)', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('HEARTBEAT.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-09 BOOTSTRAP.md fixture: zero diagnostics (no rules target it)', () => {
    const r = runLint({ rules: STARTER_RULES_V0, files: [loadFile('BOOTSTRAP.md')] });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-10 full 9-file workspace: zero diagnostics across the entire pack', () => {
    const files: LintFile[] = [
      loadFile('AGENTS.md'),
      loadFile('SOUL.md'),
      loadFile('TOOLS.md'),
      loadFile('IDENTITY.md'),
      loadFile('USER.md'),
      loadFile('HEARTBEAT.md'),
      loadFile('BOOTSTRAP.md'),
      loadFile('MEMORY.md'),
      loadFile('SKILL.md'),
    ];
    const r = runLint({ rules: STARTER_RULES_V0, files });
    expect(r.diagnostics).toEqual([]);
  });

  it('RW-11 stats record correct invocation counts across full workspace', () => {
    const files: LintFile[] = [
      loadFile('AGENTS.md'),
      loadFile('SOUL.md'),
      loadFile('TOOLS.md'),
      loadFile('IDENTITY.md'),
      loadFile('USER.md'),
      loadFile('HEARTBEAT.md'),
      loadFile('BOOTSTRAP.md'),
      loadFile('MEMORY.md'),
      loadFile('SKILL.md'),
    ];
    const r = runLint({ rules: STARTER_RULES_V0, files });
    // starter-v0 has 10 rules. Each rule's appliesTo is one specific
    // file (no wildcards in this pack), so each rule should be invoked
    // exactly once (its targeted file appears once in the input).
    for (const rule of STARTER_RULES_V0) {
      expect(r.stats.get(rule.id), `${rule.id} expected invocation count`).toBe(1);
    }
  });
});
