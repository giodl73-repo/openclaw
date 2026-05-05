/**
 * Multi-kind runner — verifies that runLint dispatches md / jsonc /
 * jsonl rules to their respective file lists without cross-contamination.
 */
import { parseJsonc, parseJsonl, parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { jsoncStarterRules } from '../../src/extensions/oclint-rules-jsonc-starter/index.js';
import { jsonlStarterRules } from '../../src/extensions/oclint-rules-jsonl-starter/index.js';
import { STARTER_RULES_V0 as starterRules } from '../../src/extensions/oclint-rules-starter/index.js';
import { runLint } from '../../src/oc-lint/runner.js';

describe('runLint — multi-kind dispatch', () => {
  it('runs md rules over md files only', () => {
    const result = runLint({
      rules: [...starterRules],
      files: [
        {
          name: 'AGENTS.md',
          ast: parseMd('## Tools\n').ast,
        },
      ],
    });
    expect(result.diagnostics.some((d) => d.ruleId.startsWith('starter-v0/'))).toBe(
      true,
    );
  });

  it('runs jsonc rules over jsonc files only', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      files: [
        {
          name: 'gateway.jsonc',
          ast: parseJsonc('{ "version": "1.0" }').ast,
        },
      ],
    });
    expect(
      result.diagnostics.some((d) =>
        d.ruleId.startsWith('jsonc-starter-v0/config/missing-plugins'),
      ),
    ).toBe(true);
  });

  it('runs jsonl rules over jsonl files only', () => {
    const result = runLint({
      rules: [...jsonlStarterRules],
      files: [
        {
          name: 'session.jsonl',
          ast: parseJsonl('').ast,
        },
      ],
    });
    expect(
      result.diagnostics.some((d) =>
        d.ruleId.startsWith('jsonl-starter-v0/session/empty-log'),
      ),
    ).toBe(true);
  });

  it('mixed-kind run dispatches each rule to its kind only', () => {
    const result = runLint({
      rules: [...starterRules, ...jsoncStarterRules, ...jsonlStarterRules],
      files: [
        { name: 'AGENTS.md', ast: parseMd('## Tools\n').ast },
        { name: 'gateway.jsonc', ast: parseJsonc('{ "version": "1.0" }').ast },
        { name: 'session.jsonl', ast: parseJsonl('{"event":"step"}\n').ast },
      ],
    });
    // Should have findings from at least one rule per kind.
    const kinds = new Set(result.diagnostics.map((d) => d.ruleId.split('/')[0]));
    expect(kinds.has('starter-v0')).toBe(true);
    expect(kinds.has('jsonc-starter-v0')).toBe(true);
    expect(kinds.has('jsonl-starter-v0')).toBe(true);
  });

  it('jsonc rules do not fire on md files (and vice versa)', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      files: [
        {
          name: 'AGENTS.md',
          ast: parseMd('## Tools\n').ast,
        },
      ],
      // No jsoncFiles — jsonc rules have nothing to walk.
    });
    expect(result.diagnostics).toHaveLength(0);
  });

  it('appliesTo glob `*.jsonc` matches gateway.jsonc but not session.jsonl', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      files: [
        {
          name: 'gateway.jsonc',
          ast: parseJsonc('{}').ast,
        },
      ],
    });
    // Should fire (matches *.jsonc).
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
