/**
 * Smoke tests for the starter extractor pack — verifies the new
 * `findOcPaths` / `resolveOcPath`-driven extraction produces the
 * same DenyRule / ToolSpec shape (in the upstream PR-1 contract
 * shape) the legacy generator did.
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '@openclaw/oc-path';
import {
  runExtractors,
  type PolicyExtractFile,
} from '../../../src/plugin-sdk/policy/index.js';
import {
  STARTER_DENY_RULE_EXTRACTORS_V0,
  STARTER_TOOL_EXTRACTORS_V0,
  denyRulesFromSoulMd,
  toolsFromToolsMd,
} from '../../../src/extensions/policy-from-md-starter/index.js';

function makeFile(name: string, raw: string): PolicyExtractFile {
  const ast = parseMd(raw).ast;
  return {
    name,
    path: `/abs/${name}`,
    relPath: name,
    raw,
    ast,
  };
}

describe('denyRulesFromSoulMd — extracts DenyRule entries from SOUL.md ## Boundaries', () => {
  it('PE-DR-01 lifts each Boundaries bullet into a DenyRule', () => {
    const file = makeFile(
      'SOUL.md',
      '# SOUL\n\n## Boundaries\n- Never post publicly without asking\n- Never share RESTRICTED externally\n',
    );
    const rules = denyRulesFromSoulMd.extract({ file });
    expect(rules).toHaveLength(2);
    expect(rules[0]?.id).toBe('SOUL-1');
    expect(rules[0]?.reason).toMatch(/Never post publicly/);
    expect(rules[1]?.id).toBe('SOUL-2');
  });

  it('PE-DR-02 produces a `tag` matcher in the `when` clause', () => {
    const file = makeFile(
      'SOUL.md',
      '## Boundaries\n- Never share RESTRICTED data externally\n',
    );
    const rules = denyRulesFromSoulMd.extract({ file });
    expect(rules[0]?.when.tag).toContain('never');
  });

  it('PE-DR-03 returns empty for a SOUL.md without a Boundaries section', () => {
    const file = makeFile('SOUL.md', '## Tone\nFriendly.\n');
    const rules = denyRulesFromSoulMd.extract({ file });
    expect(rules).toEqual([]);
  });

  it('PE-DR-04 spec carries the appliesTo glob and required SDK version', () => {
    expect(denyRulesFromSoulMd.appliesTo).toBe('SOUL.md');
    expect(denyRulesFromSoulMd.requires?.sdkVersion).toBe('0.1.0');
  });
});

describe('toolsFromToolsMd — extracts ToolSpec entries from TOOLS.md ## Tools', () => {
  it('PE-TL-01 lifts each `### name # meta` sub-heading into a ToolSpec', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### post-to-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    expect(tools).toHaveLength(2);
    const post = tools.find((t) => t.id === 'post-to-channel');
    expect(post?.risk).toBe('critical'); // R5 → critical
    expect(post?.capabilities).toContain('COMMUNICATE');
    expect(post?.capabilities).toContain('IRREVERSIBLE_EXTERNAL');
    expect(post?.sensitivity).toBe('restricted');
    const read = tools.find((t) => t.id === 'read-doc');
    expect(read?.risk).toBe('low'); // R1 → low
    expect(read?.capabilities).toEqual(['READ']);
  });

  it('PE-TL-02 maps R<n> numeric levels to upstream string union', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### t0 # R0\n### t1 # R1\n### t2 # R2\n### t3 # R3\n### t4 # R4\n### t5 # R5\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    const byId = new Map(tools.map((t) => [t.id, t.risk]));
    expect(byId.get('t0')).toBe('low');
    expect(byId.get('t1')).toBe('low');
    expect(byId.get('t2')).toBe('medium');
    expect(byId.get('t3')).toBe('medium');
    expect(byId.get('t4')).toBe('high');
    expect(byId.get('t5')).toBe('critical');
  });

  it('PE-TL-03 returns empty for a TOOLS.md without a Tools section', () => {
    const file = makeFile('TOOLS.md', '## Other\nSomething\n');
    const tools = toolsFromToolsMd.extract({ file });
    expect(tools).toEqual([]);
  });

  it('PE-TL-04 explicit `sensitivity:<level>` overrides capability-derived default', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### t # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL, sensitivity:public\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    // IRREVERSIBLE_EXTERNAL would default to `restricted`; explicit
    // `sensitivity:public` wins.
    expect(tools[0]?.sensitivity).toBe('public');
  });

  it('PE-TL-05 each known sensitivity level is supported via the explicit form', () => {
    const file = makeFile(
      'TOOLS.md',
      [
        '## Tools',
        '### a # R1, READ, sensitivity:public',
        '### b # R1, READ, sensitivity:internal',
        '### c # R1, READ, sensitivity:confidential',
        '### d # R1, READ, sensitivity:restricted',
      ].join('\n') + '\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    const byId = new Map(tools.map((t) => [t.id, t.sensitivity]));
    expect(byId.get('a')).toBe('public');
    expect(byId.get('b')).toBe('internal');
    expect(byId.get('c')).toBe('confidential');
    expect(byId.get('d')).toBe('restricted');
  });

  it('PE-TL-06 unknown explicit sensitivity falls through to capability default', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### t # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL, sensitivity:bogus\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    // Unknown token ignored; IRREVERSIBLE_EXTERNAL → restricted.
    expect(tools[0]?.sensitivity).toBe('restricted');
  });

  it('PE-TL-07 legacy bare-word sensitivity (`R3, READ, public`) still works', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### t # R3, READ, public\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    expect(tools[0]?.sensitivity).toBe('public');
  });

  it('PE-TL-08 substring-only matches (`public-api` in tool id) do NOT trigger sensitivity', () => {
    // The tool id contains "public" as a substring, but no token-level
    // match. Without IRREVERSIBLE_EXTERNAL/etc, default is `internal`.
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### public-api-call # R1, READ\n',
    );
    const tools = toolsFromToolsMd.extract({ file });
    // The meta line is `R1, READ` — no sensitivity tokens there.
    expect(tools[0]?.sensitivity).toBe('internal');
  });
});

describe('runExtractors — orchestrates specs over files (parallel to runLint / DoctorContext.detect)', () => {
  it('PE-RUN-01 runs deny-rule extractors only against SOUL.md', () => {
    const soulFile = makeFile(
      'SOUL.md',
      '## Boundaries\n- Never share secrets\n',
    );
    const toolsFile = makeFile(
      'TOOLS.md',
      '## Tools\n### t # R1, READ\n',
    );
    const result = runExtractors({
      specs: STARTER_DENY_RULE_EXTRACTORS_V0,
      files: [soulFile, toolsFile],
    });
    expect(result.length).toBe(1);
    expect(result[0]?.fromFile).toBe('SOUL.md');
    expect(result[0]?.fromSpecId).toBe('starter-v0/deny-rules/from-soul-md');
  });

  it('PE-RUN-02 a throwing spec is skipped (matches lint/doctor runner)', () => {
    const file = makeFile('SOUL.md', '## Boundaries\n- ok\n');
    const result = runExtractors({
      specs: [
        {
          id: 'crashy',
          description: 'always throws',
          appliesTo: '*',
          extract: () => {
            throw new Error('boom');
          },
        },
        ...STARTER_DENY_RULE_EXTRACTORS_V0,
      ],
      files: [file],
    });
    // Crashy spec returned no entries; deny rule extractor still ran.
    expect(result.length).toBe(1);
    expect(result[0]?.fromSpecId).toBe('starter-v0/deny-rules/from-soul-md');
  });

  it('PE-RUN-03 abort signal stops the run between files', () => {
    const file = makeFile('SOUL.md', '## Boundaries\n- ok\n');
    const ac = new AbortController();
    ac.abort();
    const result = runExtractors({
      specs: STARTER_DENY_RULE_EXTRACTORS_V0,
      files: [file],
      signal: ac.signal,
    });
    expect(result).toEqual([]);
  });

  it('PE-RUN-04 starter tool extractor pack produces ToolSpec results', () => {
    const file = makeFile(
      'TOOLS.md',
      '## Tools\n### t # R3, WRITE\n',
    );
    const result = runExtractors({
      specs: STARTER_TOOL_EXTRACTORS_V0,
      files: [file],
    });
    expect(result.length).toBe(1);
    expect(result[0]?.value.id).toBe('t');
    expect(result[0]?.value.risk).toBe('medium');
  });
});
