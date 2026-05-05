/**
 * Adapter tests — bridges PolicyIR / Decision to the upstream
 * `registerTrustedToolPolicy` shape.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LKGFingerprint } from '@openclaw/lkg';
import {
  loadPolicyIRFromFile,
  makePolicyEvaluator,
  mapDecisionToHostShape,
  policyTrustedToolPolicy,
} from '../../../src/plugin-sdk/policy/adapter.js';
import type { Decision, PolicyIR } from '../../../src/plugin-sdk/policy/types.js';

const ANCHOR: LKGFingerprint = {
  hash: 'a'.repeat(64),
  bytes: 0,
  observedAt: '2026-05-04T12:00:00.000Z',
};

function makePolicy(overrides: Partial<PolicyIR> = {}): PolicyIR {
  return {
    version: '0.1.0',
    policyId: 'b'.repeat(64),
    generatedAt: '2026-05-04T12:00:00.000Z',
    generatedFrom: ANCHOR,
    tools: [
      { id: 'read-doc', capabilities: ['READ'], risk: 'low', sensitivity: 'public' },
      {
        id: 'send-email',
        capabilities: ['COMMUNICATE', 'IRREVERSIBLE_EXTERNAL'],
        risk: 'critical',
        sensitivity: 'restricted',
      },
    ],
    denyRules: [],
    ...overrides,
  };
}

describe('mapDecisionToHostShape — Decision → PluginToolPolicyDecision', () => {
  it('AD-01 allow → allow', () => {
    const d: Decision = { kind: 'allow' };
    expect(mapDecisionToHostShape(d)).toEqual({ decision: 'allow' });
  });

  it('AD-02 deny → block (verb rename, semantics identical)', () => {
    const d: Decision = { kind: 'deny', reason: 'r' };
    expect(mapDecisionToHostShape(d)).toEqual({ decision: 'block', reason: 'r' });
  });

  it('AD-03 deny with rule preserves the rule attribution', () => {
    const d: Decision = { kind: 'deny', reason: 'r', rule: 'SOUL-1' };
    expect(mapDecisionToHostShape(d)).toEqual({
      decision: 'block',
      reason: 'r',
      rule: 'SOUL-1',
    });
  });

  it('AD-04 requires-approval → requires-approval', () => {
    const d: Decision = { kind: 'requires-approval', reason: 'critical' };
    expect(mapDecisionToHostShape(d)).toEqual({
      decision: 'requires-approval',
      reason: 'critical',
    });
  });

  it('AD-05 params → mutate-params', () => {
    const d: Decision = { kind: 'params', mutate: { token: '${ENV}' } };
    expect(mapDecisionToHostShape(d)).toEqual({
      decision: 'mutate-params',
      mutate: { token: '${ENV}' },
    });
  });
});

describe('makePolicyEvaluator — pure (event) → Decision closure', () => {
  it('PE-01 closure carries the policy by reference', () => {
    const evaluate = makePolicyEvaluator(makePolicy());
    expect(evaluate({ toolName: 'read-doc' })).toEqual({ kind: 'allow' });
    expect(evaluate({ toolName: 'send-email' }).kind).toBe('requires-approval');
  });

  it('PE-02 unknown tool → deny (closed world)', () => {
    const evaluate = makePolicyEvaluator(makePolicy());
    const d = evaluate({ toolName: 'mystery' });
    expect(d.kind).toBe('deny');
  });

  it('PE-03 args flow through to deny rule tag matching', () => {
    const policy = makePolicy({
      denyRules: [
        {
          id: 'OPS-1',
          when: { tag: '*never*share*restricted*' },
          reason: 'no RESTRICTED data',
        },
      ],
    });
    const evaluate = makePolicyEvaluator(policy);
    const d = evaluate({
      toolName: 'read-doc',
      args: { action: 'never share these RESTRICTED documents' },
    });
    expect(d.kind).toBe('deny');
  });
});

describe('policyTrustedToolPolicy — registration spec for upstream slot', () => {
  it('PT-01 produces a registration with id + evaluate', () => {
    const reg = policyTrustedToolPolicy({ id: 'pol-md', policy: makePolicy() });
    expect(reg.id).toBe('pol-md');
    expect(typeof reg.evaluate).toBe('function');
  });

  it('PT-02 evaluate returns upstream-shaped PluginToolPolicyDecision', () => {
    const reg = policyTrustedToolPolicy({ id: 'pol-md', policy: makePolicy() });
    expect(reg.evaluate({ toolName: 'read-doc' })).toEqual({ decision: 'allow' });
    const sendEmail = reg.evaluate({ toolName: 'send-email' });
    expect(sendEmail.decision).toBe('requires-approval');
  });

  it('PT-03 unknown tool flows through to block (deny → block rename)', () => {
    const reg = policyTrustedToolPolicy({ id: 'pol-md', policy: makePolicy() });
    const d = reg.evaluate({ toolName: 'mystery' });
    expect(d.decision).toBe('block');
  });
});

describe('loadPolicyIRFromFile — file read convenience', () => {
  it('LP-01 reads and parses a PolicyIR JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pol-load-'));
    const path = join(dir, 'ir.json');
    const ir = makePolicy();
    writeFileSync(path, JSON.stringify(ir, null, 2), 'utf-8');
    const loaded = await loadPolicyIRFromFile(path);
    expect(loaded.policyId).toBe(ir.policyId);
    expect(loaded.tools).toHaveLength(ir.tools.length);
  });
});

describe('E2E adapter — full pipeline simulation', () => {
  it('E2E-01 host pattern: load IR → register adapter → evaluate', async () => {
    // Simulate the upstream registration pattern:
    //   const policy = await loadPolicyIRFromFile(POLICY_PATH);
    //   api.registerTrustedToolPolicy(
    //     policyTrustedToolPolicy({ id: 'pol-md', policy })
    //   );
    //
    // Then a tool call comes in and the runner invokes evaluate(...).
    const dir = mkdtempSync(join(tmpdir(), 'pol-e2e-'));
    const path = join(dir, 'ir.json');
    writeFileSync(path, JSON.stringify(makePolicy(), null, 2), 'utf-8');

    const policy = await loadPolicyIRFromFile(path);
    const reg = policyTrustedToolPolicy({ id: 'pol-md', policy });

    // Simulate three tool calls flowing through the runner.
    const callA = reg.evaluate({ toolName: 'read-doc' });
    const callB = reg.evaluate({ toolName: 'send-email' });
    const callC = reg.evaluate({ toolName: 'unknown-tool' });

    expect(callA.decision).toBe('allow');
    expect(callB.decision).toBe('requires-approval');
    expect(callC.decision).toBe('block');
  });
});
