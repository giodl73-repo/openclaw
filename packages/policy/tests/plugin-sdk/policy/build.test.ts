/**
 * buildPolicyIR tests — orchestrate extractors → composed PolicyIR.
 * E2E: workspace files → PolicyIR with stable policyId.
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '@openclaw/oc-path';
import type { LKGFingerprint } from '@openclaw/lkg';
import {
  buildPolicyIR,
  type PolicyExtractFile,
} from '../../../src/plugin-sdk/policy/index.js';
import {
  STARTER_DENY_RULE_EXTRACTORS_V0,
  STARTER_TOOL_EXTRACTORS_V0,
} from '../../../src/extensions/policy-from-md-starter/index.js';

const DUMMY_ANCHOR: LKGFingerprint = {
  hash: 'a'.repeat(64),
  bytes: 100,
  observedAt: '2026-05-04T12:00:00.000Z',
};

function makeFile(name: string, raw: string): PolicyExtractFile {
  return {
    name,
    path: `/abs/${name}`,
    relPath: name,
    raw,
    ast: parseMd(raw).ast,
  };
}

describe('buildPolicyIR — workspace files → PolicyIR', () => {
  it('BPI-01 composes tools + deny rules from canonical files', () => {
    const soul = makeFile(
      'SOUL.md',
      '## Boundaries\n- Never share RESTRICTED data\n- Never bypass approval\n',
    );
    const tools = makeFile(
      'TOOLS.md',
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n',
    );
    const ir = buildPolicyIR({
      files: [soul, tools],
      toolExtractors: STARTER_TOOL_EXTRACTORS_V0,
      denyRuleExtractors: STARTER_DENY_RULE_EXTRACTORS_V0,
      anchor: DUMMY_ANCHOR,
      nowIso: () => '2026-05-04T12:00:00.000Z',
    });
    expect(ir.tools).toHaveLength(2);
    expect(ir.denyRules).toHaveLength(2);
    expect(ir.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(ir.generatedFrom).toBe(DUMMY_ANCHOR);
    expect(ir.generatedAt).toBe('2026-05-04T12:00:00.000Z');
    expect(ir.version).toBe('0.1.0');
  });

  it('BPI-02 same input → same policyId (determinism)', () => {
    const soul = makeFile('SOUL.md', '## Boundaries\n- Never\n');
    const tools = makeFile('TOOLS.md', '## Tools\n### t # R1, READ\n');
    const opts = {
      files: [soul, tools],
      toolExtractors: STARTER_TOOL_EXTRACTORS_V0,
      denyRuleExtractors: STARTER_DENY_RULE_EXTRACTORS_V0,
      anchor: DUMMY_ANCHOR,
      nowIso: () => '2026-05-04T12:00:00.000Z',
    };
    const a = buildPolicyIR(opts);
    const b = buildPolicyIR(opts);
    expect(a.policyId).toBe(b.policyId);
  });

  it('BPI-03 dedupes tools by id (last writer wins)', () => {
    const tools = makeFile(
      'TOOLS.md',
      '## Tools\n### dup # R1, READ\n### dup # R5, IRREVERSIBLE_EXTERNAL\n',
    );
    const ir = buildPolicyIR({
      files: [tools],
      toolExtractors: STARTER_TOOL_EXTRACTORS_V0,
      denyRuleExtractors: STARTER_DENY_RULE_EXTRACTORS_V0,
      anchor: DUMMY_ANCHOR,
      nowIso: () => '2026-05-04T12:00:00.000Z',
    });
    expect(ir.tools).toHaveLength(1);
    // Second declaration wins.
    expect(ir.tools[0]?.risk).toBe('critical');
  });

  it('BPI-04 empty workspace produces a valid (empty) IR with stable policyId', () => {
    const ir = buildPolicyIR({
      files: [],
      toolExtractors: STARTER_TOOL_EXTRACTORS_V0,
      denyRuleExtractors: STARTER_DENY_RULE_EXTRACTORS_V0,
      anchor: DUMMY_ANCHOR,
      nowIso: () => '2026-05-04T12:00:00.000Z',
    });
    expect(ir.tools).toEqual([]);
    expect(ir.denyRules).toEqual([]);
    expect(ir.policyId).toMatch(/^[0-9a-f]{64}$/);
  });
});
