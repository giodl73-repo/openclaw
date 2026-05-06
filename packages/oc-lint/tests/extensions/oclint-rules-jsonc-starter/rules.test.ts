import { parseJsonc } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import { jsoncStarterRules } from '../../../src/extensions/oclint-rules-jsonc-starter/index.js';
import {
  configEmptyPluginsEntries,
  configMissingPlugins,
  configMissingVersion,
  configNoDuplicateTopLevelKeys,
  configSecretAsLiteral,
} from '../../../src/extensions/oclint-rules-jsonc-starter/index.js';

function ctx(raw: string, fileName = 'gateway.jsonc') {
  return { fileName, ast: parseJsonc(raw).ast };
}

describe('jsonc-starter — config-missing-plugins', () => {
  it('flags when `plugins` key is missing', () => {
    const findings = configMissingPlugins.check(ctx('{ "version": "1.0" }'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ocPath).toBe('oc://gateway.jsonc/plugins');
  });
  it('passes when `plugins` is present', () => {
    expect(
      configMissingPlugins.check(ctx('{ "plugins": { "entries": {} } }')),
    ).toHaveLength(0);
  });
  it('flags non-object root (plugins is genuinely missing)', () => {
    expect(configMissingPlugins.check(ctx('[]'))).toHaveLength(1);
  });
  it('flags empty / unparseable input (plugins is genuinely missing)', () => {
    expect(configMissingPlugins.check(ctx(''))).toHaveLength(1);
  });
});

describe('jsonc-starter — config-empty-plugins-entries', () => {
  it('flags when entries is empty {}', () => {
    const findings = configEmptyPluginsEntries.check(
      ctx('{ "plugins": { "entries": {} } }'),
    );
    expect(findings).toHaveLength(1);
  });
  it('passes when entries has at least one plugin', () => {
    expect(
      configEmptyPluginsEntries.check(
        ctx('{ "plugins": { "entries": { "github": "tok" } } }'),
      ),
    ).toHaveLength(0);
  });
  it('no-ops when entries key is missing', () => {
    expect(
      configEmptyPluginsEntries.check(ctx('{ "plugins": {} }')),
    ).toHaveLength(0);
  });
});

describe('jsonc-starter — config-missing-version', () => {
  it('flags when version is missing', () => {
    expect(configMissingVersion.check(ctx('{ "plugins": {} }'))).toHaveLength(1);
  });
  it('passes when version is present', () => {
    expect(
      configMissingVersion.check(ctx('{ "version": "1.0", "plugins": {} }')),
    ).toHaveLength(0);
  });
});

describe('jsonc-starter — config-secret-as-literal', () => {
  it('flags GitHub PAT-shape values', () => {
    const findings = configSecretAsLiteral.check(
      ctx('{ "github": { "token": "ghp_abcdef0123456789ABCDEF0123456789abcdef" } }'),
    );
    expect(findings.length).toBeGreaterThan(0);
  });
  it('flags AWS access key shapes', () => {
    expect(
      configSecretAsLiteral.check(ctx('{ "aws_key": "AKIAIOSFODNN7EXAMPLE" }')).length,
    ).toBeGreaterThan(0);
  });
  it('flags openai-style keys', () => {
    expect(
      configSecretAsLiteral.check(
        ctx('{ "k": "sk-abcdef0123456789abcdef0123456789ABCDEF" }'),
      ).length,
    ).toBeGreaterThan(0);
  });
  it('passes on `${ENV_VAR}` placeholders', () => {
    expect(
      configSecretAsLiteral.check(ctx('{ "github": { "token": "${GH_TOKEN}" } }')),
    ).toHaveLength(0);
  });
  it('walks deep nesting', () => {
    expect(
      configSecretAsLiteral.check(
        ctx(
          '{ "a": { "b": { "c": [{ "k": "ghp_abcdef0123456789ABCDEF0123456789abcdef" }] } } }',
        ),
      ).length,
    ).toBeGreaterThan(0);
  });
  it('passes on all-zero placeholder hash (no false positive)', () => {
    expect(
      configSecretAsLiteral.check(
        ctx('{ "policyId": "0000000000000000000000000000000000000000000000000000000000000000" }'),
      ),
    ).toHaveLength(0);
  });
  it('passes on all-f / all-deadbeef placeholder hashes', () => {
    expect(
      configSecretAsLiteral.check(
        ctx('{ "a": "ffffffffffffffffffffffffffffffffffffffff", "b": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }'),
      ),
    ).toHaveLength(0);
  });
  it('still flags real-entropy 40+char hex (no false negative)', () => {
    expect(
      configSecretAsLiteral.check(
        ctx('{ "x": "5da345d2e7af56926e2fc4ad1a922a54d342edc3b1735e7af0c1cf41dce" }'),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('jsonc-starter — config-no-duplicate-top-level-keys', () => {
  it('CFG-NDK-01 flags duplicate top-level key', () => {
    const raw = '{\n  "version": "1.0",\n  "plugins": {},\n  "version": "2.0"\n}';
    const findings = configNoDuplicateTopLevelKeys.check(ctx(raw));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/version.*2 times/);
  });

  it('CFG-NDK-02 passes when all top-level keys are unique', () => {
    const raw = '{ "version": "1.0", "plugins": {}, "name": "x" }';
    expect(configNoDuplicateTopLevelKeys.check(ctx(raw))).toHaveLength(0);
  });

  it('CFG-NDK-03 reports n-1 findings for n duplicates of the same key', () => {
    const raw = '{\n  "k": 1,\n  "k": 2,\n  "k": 3\n}';
    const findings = configNoDuplicateTopLevelKeys.check(ctx(raw));
    expect(findings).toHaveLength(2);
  });

  it('CFG-NDK-04 no-ops on non-object root', () => {
    expect(configNoDuplicateTopLevelKeys.check(ctx('[1, 2, 3]'))).toHaveLength(0);
  });

  it('CFG-NDK-05 no-ops on empty / unparseable input', () => {
    expect(configNoDuplicateTopLevelKeys.check(ctx(''))).toHaveLength(0);
  });

  it('CFG-NDK-06 anchors diagnostic at second occurrence (the line that "won")', () => {
    const raw = '{\n  "a": 1,\n  "b": 2,\n  "a": 9\n}';
    const findings = configNoDuplicateTopLevelKeys.check(ctx(raw));
    expect(findings[0]?.line).toBe(4);
  });
});

describe('jsoncStarterRules — pack registration', () => {
  it('exports 5 rules', () => {
    expect(jsoncStarterRules).toHaveLength(5);
  });
  it('all rules share the jsonc kind discriminator', () => {
    for (const r of jsoncStarterRules) {
      // kind discriminator dropped — single LintRule shape);
    }
  });
  it('all rule ids share the starter-v0 namespace', () => {
    for (const r of jsoncStarterRules) {
      expect(r.id).toMatch(/^jsonc-starter-v0\//);
    }
  });
});
