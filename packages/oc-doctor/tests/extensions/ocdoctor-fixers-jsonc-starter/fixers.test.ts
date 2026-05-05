import { parseJsonc } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  configAddPluginsStub,
  configAddVersionStub,
  configRedactSecretLiteral,
  jsoncStarterFixers,
} from '../../../src/extensions/ocdoctor-fixers-jsonc-starter/index.js';
import { syntheticMatch } from '../../test-match.js';

async function detect(spec: typeof configAddPluginsStub, raw: string, fileName = 'gateway.jsonc') {
  return await spec.detect({ fileName, ast: parseJsonc(raw).ast, raw });
}
async function fix(spec: typeof configAddPluginsStub, raw: string, fileName = 'gateway.jsonc') {
  const ast = parseJsonc(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({
    fileName,
    ast,
    raw,
    match: matches[0]!.match,
  });
}

/** Fan-out helper: re-detect after each fix until no findings remain. */
async function fixAll(spec: typeof configAddPluginsStub, raw: string, fileName = 'gateway.jsonc') {
  let next = raw;
  for (let pass = 0; pass < 20; pass++) {
    const ast = parseJsonc(next).ast;
    const matches = await spec.detect({ fileName, ast, raw: next });
    if (matches.length === 0) return next;
    next = await spec.fix({ fileName, ast, raw: next, match: matches[0]!.match });
  }
  return next;
}

describe('configAddPluginsStub', () => {
  it('detects missing plugins', async () => {
    expect((await detect(configAddPluginsStub, '{ "version": "1.0" }')).length).toBe(1);
  });
  it('does not detect when plugins is present', async () => {
    expect(
      (await detect(configAddPluginsStub, '{ "plugins": { "entries": {} } }')).length,
    ).toBe(0);
  });
  it('inserts plugins stub into a file with other keys', async () => {
    const before = '{ "version": "1.0" }';
    const after = await fix(configAddPluginsStub, before);
    expect(after).toContain('"plugins"');
    expect(after).toContain('"entries"');
    expect(JSON.parse(after)).toEqual({
      version: '1.0',
      plugins: { entries: {} },
    });
  });
  it('inserts plugins stub into an empty object', async () => {
    const after = await fix(configAddPluginsStub, '{}');
    expect(JSON.parse(after)).toEqual({ plugins: { entries: {} } });
  });
  it('is idempotent — second fix is a no-op', async () => {
    const once = await fix(configAddPluginsStub, '{ "version": "1.0" }');
    const twice = await fix(configAddPluginsStub, once);
    expect(twice).toBe(once);
  });
  it('no-ops on non-object root', async () => {
    expect(await fix(configAddPluginsStub, '[]')).toBe('[]');
  });
});

describe('configAddVersionStub', () => {
  it('detects missing version', async () => {
    expect((await detect(configAddVersionStub, '{ "plugins": {} }')).length).toBe(1);
  });
  it('does not detect when version is present', async () => {
    expect(
      (await detect(configAddVersionStub, '{ "version": "1.0", "plugins": {} }')).length,
    ).toBe(0);
  });
  it('inserts version stub at the head of the object', async () => {
    const after = await fix(configAddVersionStub, '{ "plugins": {} }');
    expect(JSON.parse(after)).toEqual({ version: '0.0.0', plugins: {} });
  });
  it('inserts version into empty object', async () => {
    const after = await fix(configAddVersionStub, '{}');
    expect(JSON.parse(after)).toEqual({ version: '0.0.0' });
  });
  it('is idempotent', async () => {
    const once = await fix(configAddVersionStub, '{ "plugins": {} }');
    const twice = await fix(configAddVersionStub, once);
    expect(twice).toBe(once);
  });
});

describe('configRedactSecretLiteral', () => {
  it('detects GitHub PAT', async () => {
    const findings = await detect(
      configRedactSecretLiteral,
      '{ "github": { "token": "ghp_abcdef0123456789ABCDEF0123456789abcdef" } }',
    );
    expect(findings.length).toBeGreaterThan(0);
  });
  it('replaces literal with placeholder', async () => {
    const before =
      '{ "github": { "token": "ghp_abcdef0123456789ABCDEF0123456789abcdef" } }';
    const after = await fix(configRedactSecretLiteral, before);
    expect(after).not.toContain('ghp_abcdef');
    expect(after).toContain('${ENV_VAR_PLACEHOLDER}');
  });
  it('handles multiple secrets in one file (fan-out)', async () => {
    const before =
      '{ "a": "ghp_abcdef0123456789ABCDEF0123456789abcdef", "b": "AKIAIOSFODNN7EXAMPLE" }';
    const after = await fixAll(configRedactSecretLiteral, before);
    expect(after).not.toContain('ghp_abcdef');
    expect(after).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
  it('is idempotent — re-running on redacted file is a no-op', async () => {
    const once = await fix(
      configRedactSecretLiteral,
      '{ "k": "ghp_abcdef0123456789ABCDEF0123456789abcdef" }',
    );
    const twice = await fix(configRedactSecretLiteral, once);
    expect(twice).toBe(once);
  });
  it('passes on `${ENV_VAR}` placeholders (not detected as secrets)', async () => {
    expect(
      (await detect(configRedactSecretLiteral, '{ "k": "${GH_TOKEN}" }')).length,
    ).toBe(0);
  });
});

describe('jsoncStarterFixers — pack registration', () => {
  it('exports 3 fixers', () => {
    expect(jsoncStarterFixers).toHaveLength(3);
  });
  it('all apply to jsonc files', () => {
    for (const f of jsoncStarterFixers) {
      expect(f.appliesTo).toMatch(/\.jsonc$|jsonc/);
    }
  });
  it('all ids share the starter-v0 namespace', () => {
    for (const f of jsoncStarterFixers) {
      expect(f.id).toMatch(/^jsonc-starter-v0\//);
    }
  });
});
