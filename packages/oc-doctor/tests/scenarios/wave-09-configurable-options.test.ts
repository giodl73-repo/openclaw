/**
 * Wave 9 — configurable fixer options.
 *
 * The OcPathFixerSpec<TOptions> generic + DoctorContext.fixerOptions
 * map lets operators override per-fixer defaults at invocation time.
 * This wave exercises:
 *   - default behavior when no override
 *   - override merging (operator partial > spec defaults)
 *   - kind-specific option types (md vs jsonc vs jsonl)
 *   - adapter wiring through DoctorContext
 *   - the 3 optional md fixers (seed-tools-todo, snap-scope, snap-tier)
 */
import { parseJsonc, parseMd } from '@openclaw/oc-path';
import { describe, expect, it, vi } from 'vitest';
import { ocPathFixerContribution } from '../../src/plugin-sdk/oc-doctor/adapter.js';
import {
  agentsSeedToolsTodo,
  memorySnapScope,
  skillSnapTier,
} from '../../src/extensions/ocdoctor-fixers-starter/index.js';
import { configRedactSecretLiteral } from '../../src/extensions/ocdoctor-fixers-jsonc-starter/index.js';
import type {
  DoctorContext,
} from '../../src/plugin-sdk/oc-doctor/types.js';
import { makeDoctorFile } from '../test-helpers.js';
import { syntheticMatch } from '../test-match.js';

function makeCtx(opts: Partial<DoctorContext> = {}): DoctorContext {
  return {
    workspaceDir: '/ws',
    files: [],
    writeFile: vi.fn(async () => undefined),
    ...opts,
  };
}

describe('wave-09 configurable options — agents/seed-tools-todo', () => {
  it('uses default placeholder when no override', async () => {
    const raw = '## Tools\n';
    const ast = parseMd(raw).ast;
    const after = await agentsSeedToolsTodo.fix({
      fileName: 'AGENTS.md',
      ast,
      raw,
      match: syntheticMatch('oc://AGENTS.md/tools'),
    });
    expect(after).toContain('TODO: list a tool here');
  });

  it('uses operator-supplied placeholder when override given', async () => {
    const raw = '## Tools\n';
    const ast = parseMd(raw).ast;
    const after = await agentsSeedToolsTodo.fix({
      fileName: 'AGENTS.md',
      ast,
      raw,
      match: syntheticMatch('oc://AGENTS.md/tools'),
      options: { placeholder: '- gh: GitHub CLI' },
    });
    expect(after).toContain('- gh: GitHub CLI');
    expect(after).not.toContain('TODO');
  });

  it('declares defaultOptions on the spec', () => {
    expect(agentsSeedToolsTodo.defaultOptions).toBeDefined();
    expect(agentsSeedToolsTodo.defaultOptions?.placeholder).toContain('TODO');
  });
});

describe('wave-09 configurable options — memory/snap-scope', () => {
  it('snaps invalid scope to default target by default', async () => {
    const raw = '---\nscope: foobar\n---\n';
    const ast = parseMd(raw).ast;
    const after = await memorySnapScope.fix({
      fileName: 'MEMORY.md',
      ast,
      raw,
      match: syntheticMatch('oc://MEMORY.md/[frontmatter]/scope'),
    });
    expect(after).toContain('scope: default');
  });

  it('honors operator-supplied targetScope', async () => {
    const raw = '---\nscope: foobar\n---\n';
    const ast = parseMd(raw).ast;
    const after = await memorySnapScope.fix({
      fileName: 'MEMORY.md',
      ast,
      raw,
      match: syntheticMatch('oc://MEMORY.md/[frontmatter]/scope'),
      options: {
        targetScope: 'project',
        allowedScopes: ['default', 'global', 'project', 'session'],
      },
    });
    expect(after).toContain('scope: project');
  });

  it('adds _auto_corrected marker on snap', async () => {
    const raw = '---\nscope: foobar\n---\n';
    const ast = parseMd(raw).ast;
    const after = await memorySnapScope.fix({
      fileName: 'MEMORY.md',
      ast,
      raw,
      match: syntheticMatch('oc://MEMORY.md/[frontmatter]/scope'),
    });
    expect(after).toContain('_auto_corrected: true');
  });

  it('detects on invalid scope, passes on valid scope', async () => {
    const invalid = parseMd('---\nscope: foobar\n---\n').ast;
    const valid = parseMd('---\nscope: default\n---\n').ast;
    expect(
      (await memorySnapScope.detect({ fileName: 'MEMORY.md', ast: invalid, raw: '' })).length,
    ).toBe(1);
    expect(
      (await memorySnapScope.detect({ fileName: 'MEMORY.md', ast: valid, raw: '' })).length,
    ).toBe(0);
  });
});

describe('wave-09 configurable options — skill/snap-tier', () => {
  it('snaps invalid tier to default target', async () => {
    const raw = '---\ntier: 99\n---\n';
    const ast = parseMd(raw).ast;
    const after = await skillSnapTier.fix({
      fileName: 'SKILL.md',
      ast,
      raw,
      match: syntheticMatch('oc://SKILL.md/[frontmatter]/tier'),
    });
    expect(after).toContain('tier: 1');
  });

  it('honors operator-supplied targetTier', async () => {
    const raw = '---\ntier: 99\n---\n';
    const ast = parseMd(raw).ast;
    const after = await skillSnapTier.fix({
      fileName: 'SKILL.md',
      ast,
      raw,
      match: syntheticMatch('oc://SKILL.md/[frontmatter]/tier'),
      options: { targetTier: 3, allowedTiers: [1, 2, 3] },
    });
    expect(after).toContain('tier: 3');
  });

  it('passes on valid tier in default allowed set', async () => {
    const ast = parseMd('---\ntier: 2\n---\n').ast;
    expect(
      (await skillSnapTier.detect({ fileName: 'SKILL.md', ast, raw: '' })).length,
    ).toBe(0);
  });
});

describe('wave-09 configurable options — config/redact-secret-literal', () => {
  it('replaces with default placeholder when no override', async () => {
    // Use the real detect output so the match carries a writable
    // leaf path (substrate `setOcPath` rejects root-replacement; the
    // synthetic helper produced an unwritable shape).
    const raw = '{ "token": "ghp_abcdef0123456789ABCDEF0123456789abcdef" }';
    const ast = parseJsonc(raw).ast;
    const matches = await configRedactSecretLiteral.detect({
      fileName: 'gateway.jsonc',
      ast,
      raw,
    });
    const after = await configRedactSecretLiteral.fix({
      fileName: 'gateway.jsonc',
      ast,
      raw,
      match: matches[0]!.match,
    });
    expect(after).toContain('${ENV_VAR_PLACEHOLDER}');
  });
});

describe('wave-09 adapter — fixerOptions threading via DoctorContext', () => {
  it('adapter passes ctx.fixerOptions[id] through to fix()', async () => {
    const writeFile = vi.fn(async () => undefined);
    const contrib = ocPathFixerContribution(memorySnapScope);
    const ctx = makeCtx({
      files: [makeDoctorFile('MEMORY.md', '/ws/MEMORY.md', '---\nscope: foobar\n---\n')],
      writeFile,
      fixerOptions: {
        [memorySnapScope.id]: {
          targetScope: 'global',
          allowedScopes: ['default', 'global', 'project', 'session'],
        },
      },
    });
    const finding = (await contrib.detect(ctx))[0]!;
    const result = await contrib.fix(ctx, finding);
    expect(result.outcome).toBe('fixed');
    const contents = (writeFile.mock.calls[0] as unknown as [string, string])[1];
    expect(contents).toContain('scope: global');
  });

  it('jsonc adapter merges fixerOptions partials over defaults', async () => {
    const writeFile = vi.fn(async () => undefined);
    const contrib = ocPathFixerContribution(configRedactSecretLiteral);
    const ctx = makeCtx({
      files: [
        makeDoctorFile(
          'gateway.jsonc',
          '/ws/gateway.jsonc',
          '{ "token": "ghp_abcdef0123456789ABCDEF0123456789abcdef" }',
        ),
      ],
      writeFile,
    });
    const finding = (await contrib.detect(ctx))[0]!;
    const result = await contrib.fix(ctx, finding);
    expect(result.outcome).toBe('fixed');
    const contents = (writeFile.mock.calls[0] as unknown as [string, string])[1];
    expect(contents).toContain('${ENV_VAR_PLACEHOLDER}');
  });

  it('adapter falls back to defaults when no fixerOptions supplied', async () => {
    const writeFile = vi.fn(async () => undefined);
    const contrib = ocPathFixerContribution(memorySnapScope);
    const ctx = makeCtx({
      files: [makeDoctorFile('MEMORY.md', '/ws/MEMORY.md', '---\nscope: foobar\n---\n')],
      writeFile,
      // no fixerOptions
    });
    const finding = (await contrib.detect(ctx))[0]!;
    const result = await contrib.fix(ctx, finding);
    expect(result.outcome).toBe('fixed');
    const contents = (writeFile.mock.calls[0] as unknown as [string, string])[1];
    expect(contents).toContain('scope: default');
  });
});

describe('wave-09 — defaults are sane', () => {
  it('every spec with options declares safe defaults', () => {
    expect(agentsSeedToolsTodo.defaultOptions?.placeholder).toBeTruthy();
    expect(memorySnapScope.defaultOptions?.targetScope).toBe('default');
    expect(memorySnapScope.defaultOptions?.allowedScopes).toContain('default');
    expect(skillSnapTier.defaultOptions?.targetTier).toBe(1);
    expect(skillSnapTier.defaultOptions?.allowedTiers).toContain(1);
  });
});
