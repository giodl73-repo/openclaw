/**
 * Runtime tests — approvalListFor + evaluateDecision.
 *
 * E2E: a guardrail loads a PolicyIR and asks "what's the decision
 * for this tool call?" — the upstream Decision shape comes back.
 */
import { describe, expect, it } from 'vitest';
import {
  approvalListFor,
  evaluateDecision,
} from '../../../src/plugin-sdk/policy/runtime.js';
import type { LKGFingerprint } from '@openclaw/lkg';
import type { PolicyIR } from '../../../src/plugin-sdk/policy/types.js';

const DUMMY_ANCHOR: LKGFingerprint = {
  hash: 'a'.repeat(64),
  bytes: 100,
  observedAt: '2026-05-04T12:00:00.000Z',
};

function makePolicy(overrides: Partial<PolicyIR> = {}): PolicyIR {
  return {
    version: '0.1.0',
    policyId: 'b'.repeat(64),
    generatedAt: '2026-05-04T12:00:00.000Z',
    generatedFrom: DUMMY_ANCHOR,
    tools: [
      {
        id: 'read-doc',
        capabilities: ['READ'],
        risk: 'low',
        sensitivity: 'public',
      },
      {
        id: 'send-email',
        capabilities: ['COMMUNICATE', 'IRREVERSIBLE_EXTERNAL'],
        risk: 'critical',
        sensitivity: 'restricted',
      },
      {
        id: 'write-memo',
        capabilities: ['WRITE'],
        risk: 'medium',
        sensitivity: 'internal',
      },
    ],
    denyRules: [],
    ...overrides,
  };
}

describe('approvalListFor', () => {
  it('AL-01 critical-risk tools require approval', () => {
    const list = approvalListFor(makePolicy());
    const ids = list.map((a) => a.toolId);
    expect(ids).toContain('send-email');
  });

  it('AL-02 IRREVERSIBLE_EXTERNAL tools require approval (regardless of risk)', () => {
    const policy = makePolicy({
      tools: [
        {
          id: 'low-risk-but-external',
          capabilities: ['IRREVERSIBLE_EXTERNAL'],
          risk: 'low',
          sensitivity: 'public',
        },
      ],
    });
    const list = approvalListFor(policy);
    expect(list.map((a) => a.toolId)).toContain('low-risk-but-external');
  });

  it('AL-03 low/medium-risk read-only tools do NOT require approval', () => {
    const list = approvalListFor(makePolicy());
    expect(list.map((a) => a.toolId)).not.toContain('read-doc');
    expect(list.map((a) => a.toolId)).not.toContain('write-memo');
  });

  it('AL-04 reason explains why each tool is on the list', () => {
    const list = approvalListFor(makePolicy());
    const send = list.find((a) => a.toolId === 'send-email');
    expect(send?.reason).toContain('risk=critical');
    expect(send?.reason).toContain('capability=IRREVERSIBLE_EXTERNAL');
  });
});

describe('evaluateDecision', () => {
  it('ED-01 unknown tool → deny (closed world)', () => {
    const decision = evaluateDecision(makePolicy(), { toolId: 'mystery' });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('unknown-tool');
    }
  });

  it('ED-02 known low-risk tool → allow', () => {
    const decision = evaluateDecision(makePolicy(), { toolId: 'read-doc' });
    expect(decision.kind).toBe('allow');
  });

  it('ED-03 critical-risk tool → requires-approval', () => {
    const decision = evaluateDecision(makePolicy(), { toolId: 'send-email' });
    expect(decision.kind).toBe('requires-approval');
    if (decision.kind === 'requires-approval') {
      expect(decision.reason).toContain('risk=critical');
    }
  });

  it('ED-04 deny rule keyed on tool id fires', () => {
    const policy = makePolicy({
      denyRules: [
        {
          id: 'OPS-1',
          when: { tool: 'read-doc' },
          reason: 'read-doc is currently disabled',
        },
      ],
    });
    const decision = evaluateDecision(policy, { toolId: 'read-doc' });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.rule).toBe('OPS-1');
      expect(decision.reason).toContain('disabled');
    }
  });

  it('ED-05 deny rule keyed on capability fires', () => {
    const policy = makePolicy({
      denyRules: [
        {
          id: 'OPS-2',
          when: { capability: 'IRREVERSIBLE_EXTERNAL' },
          reason: 'no irreversible actions in audit mode',
        },
      ],
    });
    const decision = evaluateDecision(policy, { toolId: 'send-email' });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.rule).toBe('OPS-2');
    }
  });

  it('ED-06 deny rule with tag matches arg substrings (case-insensitive)', () => {
    const policy = makePolicy({
      denyRules: [
        {
          id: 'SOUL-1',
          when: { tag: '*restricted*' },
          reason: 'no RESTRICTED data',
        },
      ],
    });
    const decision = evaluateDecision(policy, {
      toolId: 'read-doc',
      args: { payload: 'This contains RESTRICTED material' },
    });
    expect(decision.kind).toBe('deny');
  });

  it('ED-07 deny rule precedes approval check (deny wins)', () => {
    const policy = makePolicy({
      denyRules: [
        { id: 'OPS-X', when: { tool: 'send-email' }, reason: 'blocked' },
      ],
    });
    const decision = evaluateDecision(policy, { toolId: 'send-email' });
    // Even though send-email is critical and would normally require
    // approval, the deny rule fires first.
    expect(decision.kind).toBe('deny');
  });
});
