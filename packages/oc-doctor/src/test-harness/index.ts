/**
 * Test harness for plugin authors.
 *
 * Minimal helpers to exercise an `OcPathFixerSpec` against in-memory
 * bytes without setting up the full doctor adapter + DoctorContext.
 * Plugin packs use these in their own test suites so they don't have
 * to reinvent fan-out + idempotency scaffolding.
 *
 *   import { runFixer, runFixerAll, assertIdempotent } from '@openclaw/oc-doctor/test-harness';
 *
 *   const after = runFixer(myFixer, 'gateway.jsonc', '{ ... }');
 *   assertIdempotent(myFixer, 'gateway.jsonc', '{ ... }');
 *
 * Convenience surface — production code should use the adapter via
 * `ocPathFixerContribution(spec)` and the host's `registerDoctorHealthContribution`.
 *
 * @module @openclaw/oc-doctor/test-harness
 */

import {
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
} from '@openclaw/oc-path';
import type {
  DoctorDetectResult,
  OcPathFixerSpec,
} from '../plugin-sdk/oc-doctor/types.js';

/**
 * Parse `raw` per filename heuristic and return the universal AST.
 * Mirror of `@openclaw/oc-lint/test-harness/parseForLint`.
 */
function parseForFix(fileName: string, raw: string): OcAst {
  const kind = inferKind(fileName);
  if (kind === 'jsonc') return parseJsonc(raw).ast;
  if (kind === 'jsonl') return parseJsonl(raw).ast;
  if (kind === 'yaml') return parseYaml(raw).ast;
  return parseMd(raw).ast;
}

/**
 * Run a fixer's detect step and return the typed results.
 */
export async function runDetect<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): Promise<readonly DoctorDetectResult[]> {
  const ast = parseForFix(fileName, raw);
  return await spec.detect({
    fileName,
    ast,
    raw,
    ...(options !== undefined ? { options } : {}),
  });
}

/**
 * Apply a single fix: detect → fix the FIRST match → return new
 * bytes. Returns `raw` unchanged if detect produces no findings.
 *
 * This is the basic per-call shape used by the doctor adapter
 * (one fix invocation per match — the detect/fix fan-out semantic).
 */
export async function runFixer<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): Promise<string> {
  const ast = parseForFix(fileName, raw);
  const matches = await spec.detect({
    fileName,
    ast,
    raw,
    ...(options !== undefined ? { options } : {}),
  });
  if (matches.length === 0) return raw;
  return await spec.fix({
    fileName,
    ast,
    raw,
    match: matches[0]!.match,
    ...(options !== undefined ? { options } : {}),
  });
}

/**
 * Apply the fan-out: re-detect after each fix until detect returns
 * empty. Caps at `maxPasses` (default 50) to bound runaway loops in
 * non-idempotent fixers (which would be a bug).
 *
 * Use this when the fixer can produce multiple findings on the same
 * input and you want the result of applying every one.
 */
export async function runFixerAll<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
  maxPasses = 50,
): Promise<string> {
  let next = raw;
  for (let pass = 0; pass < maxPasses; pass++) {
    const ast = parseForFix(fileName, next);
    const matches = await spec.detect({
      fileName,
      ast,
      raw: next,
      ...(options !== undefined ? { options } : {}),
    });
    if (matches.length === 0) return next;
    next = await spec.fix({
      fileName,
      ast,
      raw: next,
      match: matches[0]!.match,
      ...(options !== undefined ? { options } : {}),
    });
  }
  return next;
}

/**
 * Assert that the fixer is idempotent on `raw`: applying once and
 * twice produces the same result. Idempotency is part of the fixer
 * contract — non-idempotent fixers can loop the doctor flow.
 *
 * Throws `Error` on violation; vitest / jest surface as test failure.
 */
export async function assertIdempotent<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): Promise<void> {
  const once = await runFixerAll(spec, fileName, raw, options);
  const twice = await runFixerAll(spec, fileName, once, options);
  if (twice !== once) {
    throw new Error(
      `fixer ${spec.id} is not idempotent on ${fileName}:\n  pass 1: ${JSON.stringify(once.slice(0, 200))}\n  pass 2: ${JSON.stringify(twice.slice(0, 200))}`,
    );
  }
}

/**
 * Assert that the fixer detects at least one finding on `raw`.
 */
export async function assertDetects<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): Promise<void> {
  const findings = await runDetect(spec, fileName, raw, options);
  if (findings.length === 0) {
    throw new Error(`expected fixer ${spec.id} to detect on ${fileName}, got 0 findings`);
  }
}

/**
 * Assert that the fixer detects nothing on `raw` — the input is
 * already in good shape.
 */
export async function assertNoDetects<TOptions = unknown>(
  spec: OcPathFixerSpec<TOptions>,
  fileName: string,
  raw: string,
  options?: TOptions,
): Promise<void> {
  const findings = await runDetect(spec, fileName, raw, options);
  if (findings.length > 0) {
    const summary = findings.map((f) => f.message).join('; ');
    throw new Error(`expected fixer ${spec.id} not to detect on ${fileName}; got: ${summary}`);
  }
}
