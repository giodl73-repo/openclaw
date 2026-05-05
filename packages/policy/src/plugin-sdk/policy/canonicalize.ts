/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — minimal impl
 * sufficient for computing `PolicyIR.policyId`.
 *
 * Why JCS: two generators producing semantically-identical PolicyIR
 * (same fields, same values, possibly different field-order or
 * formatting) MUST produce the same `policyId`. The Snap PR-RFC's
 * snapshot id uses the same rule.
 *
 * Scope: scalar primitives + objects + arrays in the shapes PolicyIR
 * actually uses. Date / BigInt / Map / Set / typed-array support is
 * not needed (they don't appear in PolicyIR). Throws on encountering
 * any of those so accidental misuse is loud.
 *
 * @module @openclaw/plugin-sdk/policy/canonicalize
 */

import { createHash } from 'node:crypto';
import type { PolicyIR } from './types.js';

/**
 * Canonicalize an arbitrary JSON-shaped value per RFC 8785. Returns
 * a UTF-8 string ready for hashing.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalizeNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v));
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // RFC 8785 §3.2.3: members in lexical (Unicode) sort order of
    // their keys. JS sort with default comparator is codepoint-based.
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(
    `canonicalize: unsupported value type (${typeof value})`,
  );
}

/**
 * Canonical number formatting per RFC 8785. NaN / Infinity are
 * rejected (they aren't JSON values).
 */
function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`canonicalize: non-finite number (${n})`);
  }
  // Integer fast path.
  if (Number.isInteger(n) && Math.abs(n) < 1e15) {
    return String(n);
  }
  // RFC 8785 §3.2.2.3 says use ECMAScript ToString — `String(n)` for
  // floats is the closest available approximation in JS. The substrate
  // doesn't currently emit fractional numbers in PolicyIR, so this
  // path is rarely hit; revisit if floating-point fields are added.
  return String(n);
}

/**
 * Compute the policyId hash for a PolicyIR body. Excludes the
 * `policyId` field itself (you cannot include a hash inside its own
 * input). Returns lowercase hex sha256.
 */
export function computePolicyId(ir: Omit<PolicyIR, 'policyId'>): string {
  const canonical = canonicalize(ir);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Compute a SHAPE hash that excludes volatile generation metadata
 * (`policyId`, `generatedAt`, `generatedFrom`). Two PolicyIRs sharing
 * the same shape hash describe the same policy semantics even if
 * they were generated at different times against different LKG
 * fingerprints.
 *
 * Drift detection: regenerate from sources, compare shape hashes.
 * If they differ, the on-disk policy.jsonc has drifted from what the
 * sources would produce — operator must regenerate or accept the
 * drift explicitly. Hash equality across regeneration cycles is the
 * load-bearing property; `policyId` cannot be used because it
 * incorporates `generatedAt` and `generatedFrom`, which always change.
 */
export function computePolicyShapeHash(ir: PolicyIR): string {
  const shape = {
    version: ir.version,
    tools: ir.tools,
    denyRules: ir.denyRules,
  };
  const canonical = canonicalize(shape);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}
