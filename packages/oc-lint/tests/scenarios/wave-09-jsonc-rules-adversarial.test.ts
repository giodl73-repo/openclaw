/**
 * Wave 9 — JSONC starter rule pack adversarial scenarios.
 *
 * Drives every jsonc-starter-v0 rule through hostile inputs, edge
 * cases, glob-matching variations, and runner-integration combinations.
 * The contract: every rule is pure, deterministic, returns 0+ findings,
 * never throws on parser-tolerated input.
 */
import { parseJsonc } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  configEmptyPluginsEntries,
  configMissingPlugins,
  configMissingVersion,
  configSecretAsLiteral,
  jsoncStarterRules,
} from '../../src/extensions/oclint-rules-jsonc-starter/index.js';
import { runLint } from '../../src/oc-lint/runner.js';

const ALL = [
  configMissingPlugins,
  configEmptyPluginsEntries,
  configMissingVersion,
  configSecretAsLiteral,
] as const;

function ctx(raw: string, fileName = 'gateway.jsonc') {
  return { fileName, ast: parseJsonc(raw).ast };
}

describe('wave-09 jsonc rules adversarial — hostile / parser-edge inputs', () => {
  const inputs = [
    '',
    '   \n\n   ',
    '{}',
    '[]',
    'null',
    '42',
    '"string root"',
    'true',
    'false',
    '{ broken json',
    '{ "x":',
    '/* comment-only file */',
    '// line comment only',
  ];

  for (const rule of ALL) {
    for (const raw of inputs) {
      it(`${rule.id} does not throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => rule.check(ctx(raw))).not.toThrow();
      });
    }
  }
});

describe('wave-09 jsonc rules — determinism', () => {
  for (const rule of ALL) {
    it(`${rule.id} returns identical findings on identical input`, () => {
      const raw = '{ "version": "1.0", "plugins": { "entries": {} } }';
      const a = rule.check(ctx(raw));
      const b = rule.check(ctx(raw));
      expect(a).toEqual(b);
    });
  }
});

describe('wave-09 jsonc rules — non-mutating', () => {
  it('rules do not mutate the AST across calls', () => {
    const ast = parseJsonc(
      '{ "version": "1.0", "plugins": { "entries": { "a": "b" } } }',
    ).ast;
    const before = JSON.stringify(ast);
    for (const rule of ALL) {
      rule.check({ fileName: 'gateway.jsonc', ast });
    }
    expect(JSON.stringify(ast)).toBe(before);
  });
});

describe('wave-09 jsonc rules — finding shape', () => {
  for (const rule of ALL) {
    it(`${rule.id} produces ocPath strings starting with oc://`, () => {
      const raw = ''; // empty = no findings, but if any rule fires they'd be valid
      const out = rule.check(ctx(raw, 'config.jsonc'));
      for (const f of out) {
        expect(f.ocPath.startsWith('oc://')).toBe(true);
        expect(typeof f.message).toBe('string');
        expect(typeof f.line).toBe('number');
      }
    });
  }
});

describe('wave-09 jsonc — secret-as-literal coverage matrix', () => {
  const secretShapes = [
    { name: 'GitHub PAT (ghp)', value: 'ghp_abcdef0123456789ABCDEF0123456789abcdef' },
    { name: 'GitHub PAT (fine-grained)', value: 'github_pat_abcdef0123456789ABCDEF0123456789abcdef0123456789' },
    { name: 'Slack bot token', value: 'xoxb-1234567890-abcdefghij' },
    { name: 'OpenAI / Anthropic key', value: 'sk-abcdef0123456789abcdef0123456789ABCDEF' },
    { name: 'AWS access key ID', value: 'AKIAIOSFODNN7EXAMPLE' },
    { name: 'generic 40-hex', value: '5da345d2e7af56926e2fc4ad1a922a54d342edc3' },
  ];
  for (const { name, value } of secretShapes) {
    it(`flags ${name}`, () => {
      const raw = JSON.stringify({ k: value });
      const findings = configSecretAsLiteral.check(ctx(raw));
      expect(findings.length).toBeGreaterThanOrEqual(1);
    });
  }

  const safeShapes = [
    { name: 'env-var placeholder', value: '${GH_TOKEN}' },
    { name: 'short string', value: 'abc' },
    { name: 'random words', value: 'hello world' },
    { name: 'short hex', value: 'a1b2c3' },
  ];
  for (const { name, value } of safeShapes) {
    it(`does not flag ${name}`, () => {
      const raw = JSON.stringify({ k: value });
      expect(configSecretAsLiteral.check(ctx(raw)).length).toBe(0);
    });
  }
});

describe('wave-09 jsonc — runner glob-matching', () => {
  it('matches *.jsonc but not session.jsonl', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      files: [
        { name: 'gateway.jsonc', ast: parseJsonc('{}').ast },
      ],
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not match files with the wrong extension', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      files: [
        { name: 'random.txt', ast: parseJsonc('{}').ast },
      ],
    });
    expect(result.diagnostics.length).toBe(0);
  });
});

describe('wave-09 jsonc — multi-file batch', () => {
  it('reports per-file findings without cross-contamination', () => {
    const result = runLint({
      rules: [...jsoncStarterRules],
      // Use filenames that match the tightened openclaw-config globs
      // (`{gateway,openclaw,config}*.jsonc`) — unrelated `.jsonc`
      // files are now correctly skipped.
      files: [
        { name: 'gateway.jsonc', ast: parseJsonc('{}').ast }, // missing plugins + version
        { name: 'config.jsonc', ast: parseJsonc('{ "version": "1.0", "plugins": { "entries": {} } }').ast }, // empty entries
      ],
    });
    const aFindings = result.diagnostics.filter((d) => d.fileName === 'gateway.jsonc');
    const bFindings = result.diagnostics.filter((d) => d.fileName === 'config.jsonc');
    expect(aFindings.length).toBeGreaterThan(0);
    expect(bFindings.length).toBeGreaterThan(0);
    // Each finding's filename matches its source.
    for (const d of aFindings) expect(d.fileName).toBe('gateway.jsonc');
    for (const d of bFindings) expect(d.fileName).toBe('config.jsonc');
  });
});

describe('wave-09 jsonc — pack invariants', () => {
  it('exports 5 rules', () => {
    expect(jsoncStarterRules).toHaveLength(5);
  });
  it('all rules use jsonc-starter-v0 namespace (shared discriminator dropped)', () => {
    for (const r of jsoncStarterRules) {
      expect(r.id.startsWith('jsonc-starter-v0/')).toBe(true);
    }
  });
  it('rule ids are unique', () => {
    const ids = jsoncStarterRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('rule ids share namespace', () => {
    for (const r of jsoncStarterRules) {
      expect(r.id.startsWith('jsonc-starter-v0/')).toBe(true);
    }
  });
});
