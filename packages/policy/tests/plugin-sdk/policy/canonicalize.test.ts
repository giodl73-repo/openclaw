/**
 * Canonicalize tests — RFC 8785 JCS subset.
 *
 * Locks the basics: scalars, key-sorted objects, arrays, undefined-
 * skipping. Any future migration to a shared canonicalizer (when
 * snap/guardrails rebuild as new substrates) MUST produce
 * byte-identical output for the inputs locked here.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computePolicyId,
  computePolicyShapeHash,
} from '../../../src/plugin-sdk/policy/canonicalize.js';
import type { PolicyIR } from '../../../src/plugin-sdk/policy/types.js';

describe('canonicalize', () => {
  it('CN-01 scalars round-trip per JCS', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-1)).toBe('-1');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize('with "quotes"')).toBe('"with \\"quotes\\""');
  });

  it('CN-02 object members are emitted in lexical sort order', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // Unicode-aware sort: capital A sorts before lowercase a.
    expect(canonicalize({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  it('CN-03 arrays preserve insertion order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('CN-04 nested structures sort recursively', () => {
    expect(canonicalize({ outer: { z: 1, a: 2 }, also: [3, 1] })).toBe(
      '{"also":[3,1],"outer":{"a":2,"z":1}}',
    );
  });

  it('CN-05 undefined values are skipped (per JS conventions)', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('CN-06 non-finite numbers throw (not JSON-representable)', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('computePolicyId', () => {
  function makeBody(): Omit<PolicyIR, 'policyId'> {
    return {
      version: '0.1.0',
      generatedAt: '2026-05-04T12:00:00.000Z',
      generatedFrom: {
        hash: 'a'.repeat(64),
        bytes: 100,
        observedAt: '2026-05-04T12:00:00.000Z',
      },
      tools: [
        { id: 't1', capabilities: ['READ'], risk: 'low', sensitivity: 'public' },
      ],
      denyRules: [
        { id: 'SOUL-1', when: { tool: 't1' }, reason: 'no' },
      ],
    };
  }

  it('CP-01 produces a stable lowercase hex sha256', () => {
    const id = computePolicyId(makeBody());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CP-02 same body → same id (determinism)', () => {
    const a = computePolicyId(makeBody());
    const b = computePolicyId(makeBody());
    expect(a).toBe(b);
  });

  it('CP-03 reordered fields → same id (JCS canonicalization)', () => {
    const a = computePolicyId(makeBody());
    // Build the same body with object keys in a different order.
    // JS object literal key order is preserved in iteration; JCS
    // sort kicks in inside canonicalize().
    const reordered: Omit<PolicyIR, 'policyId'> = {
      denyRules: [{ reason: 'no', when: { tool: 't1' }, id: 'SOUL-1' }],
      tools: [
        { sensitivity: 'public', risk: 'low', capabilities: ['READ'], id: 't1' },
      ],
      generatedFrom: {
        observedAt: '2026-05-04T12:00:00.000Z',
        bytes: 100,
        hash: 'a'.repeat(64),
      },
      generatedAt: '2026-05-04T12:00:00.000Z',
      version: '0.1.0',
    };
    const b = computePolicyId(reordered);
    expect(a).toBe(b);
  });

  it('CP-04 changing the body changes the id', () => {
    const a = computePolicyId(makeBody());
    const mutated = makeBody();
    const b = computePolicyId({
      ...mutated,
      tools: [...mutated.tools, { id: 't2', capabilities: [], risk: 'low', sensitivity: 'public' }],
    });
    expect(a).not.toBe(b);
  });
});

describe('computePolicyShapeHash', () => {
  function makeIR(overrides: Partial<PolicyIR> = {}): PolicyIR {
    return {
      version: '0.1.0',
      policyId: 'b'.repeat(64),
      generatedAt: '2026-05-04T12:00:00.000Z',
      generatedFrom: {
        hash: 'a'.repeat(64),
        bytes: 100,
        observedAt: '2026-05-04T12:00:00.000Z',
      },
      tools: [
        { id: 't1', capabilities: ['READ'], risk: 'low', sensitivity: 'public' },
      ],
      denyRules: [
        { id: 'SOUL-1', when: { tool: 't1' }, reason: 'no' },
      ],
      ...overrides,
    };
  }

  it('CSH-01 produces a stable lowercase hex sha256', () => {
    const h = computePolicyShapeHash(makeIR());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CSH-02 same shape with different generatedAt → same hash (drift-resilient)', () => {
    const a = computePolicyShapeHash(makeIR({ generatedAt: '2026-05-04T12:00:00.000Z' }));
    const b = computePolicyShapeHash(makeIR({ generatedAt: '2026-06-15T08:30:00.000Z' }));
    expect(a).toBe(b);
  });

  it('CSH-03 same shape with different generatedFrom anchor → same hash', () => {
    const a = computePolicyShapeHash(
      makeIR({
        generatedFrom: { hash: 'a'.repeat(64), bytes: 100, observedAt: '2026-05-04T12:00:00.000Z' },
      }),
    );
    const b = computePolicyShapeHash(
      makeIR({
        generatedFrom: { hash: 'd'.repeat(64), bytes: 999, observedAt: '2026-06-15T08:30:00.000Z' },
      }),
    );
    expect(a).toBe(b);
  });

  it('CSH-04 same shape with different policyId → same hash (excluded)', () => {
    const a = computePolicyShapeHash(makeIR({ policyId: '0'.repeat(64) }));
    const b = computePolicyShapeHash(makeIR({ policyId: '1'.repeat(64) }));
    expect(a).toBe(b);
  });

  it('CSH-05 changing tools changes the hash (real drift)', () => {
    const a = computePolicyShapeHash(makeIR());
    const b = computePolicyShapeHash(
      makeIR({
        tools: [
          { id: 't1', capabilities: ['READ'], risk: 'low', sensitivity: 'public' },
          { id: 't2', capabilities: [], risk: 'low', sensitivity: 'public' },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it('CSH-06 changing version changes the hash (schema drift counts)', () => {
    const a = computePolicyShapeHash(makeIR({ version: '0.1.0' }));
    const b = computePolicyShapeHash(makeIR({ version: '0.2.0' }));
    expect(a).not.toBe(b);
  });
});
