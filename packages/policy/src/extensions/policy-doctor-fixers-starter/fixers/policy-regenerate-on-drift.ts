/**
 * Fixer: `policy-starter-v0/policy/regenerate-on-drift`
 * Pairs with: the CLI's `openclaw-policy check <workspace>` drift
 *             detection (CLI-POLICY-011, CLI-POLICY-014).
 *
 * Detect drift between sources (TOOLS.md / SOUL.md / ...) and the
 * on-disk `policy.jsonc`; when drifted, regenerate `policy.jsonc`
 * from sources using the registered generator.
 *
 * **Canonical plugin shape**: this fixer uses the same
 * `OcPathFixerSpec` contract as every other doctor fixer in the
 * ecosystem. Two contract additions enabled it:
 *
 *   - `siblingFiles?: readonly DoctorFile[]` on detect/fix input —
 *     read access to the rest of the workspace (added in this
 *     prototype to support cross-file fixers natively).
 *   - `Promise<...>` return types on detect/fix — async generators
 *     resolve at fixer time, not at adapter time.
 *
 * Drift detection is the canonical use case for both extensions; the
 * same surfaces are now available to any plugin that needs cross-file
 * invariants or async work.
 */
import {
  parseOcPath,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
  type OcKind,
} from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import {
  computePolicyShapeHash,
  getPolicyGenerator,
  type PolicyExtractFile,
  type PolicyIR,
} from '../../../plugin-sdk/policy/index.js';

// Importing the starter pack registers the `md` generator.
import '../../policy-from-md-starter/generator.js';
import type { MdGeneratorInput } from '../../policy-from-md-starter/generator.js';

const GENERATOR_ID = 'md';

function inferKind(name: string): OcKind | null {
  if (name.endsWith('.md')) return 'md';
  if (name.endsWith('.jsonc') || name.endsWith('.json')) return 'jsonc';
  if (name.endsWith('.jsonl')) return 'jsonl';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml';
  return null;
}

function parseForKind(kind: OcKind, raw: string): OcAst {
  switch (kind) {
    case 'md':
      return parseMd(raw).ast;
    case 'jsonc':
      return parseJsonc(raw).ast;
    case 'jsonl':
      return parseJsonl(raw).ast;
    case 'yaml':
      return parseYaml(raw).ast;
  }
}

function extractFilesFromSiblings(
  siblings: readonly { name: string; path: string; raw: string }[],
): readonly PolicyExtractFile[] {
  const out: PolicyExtractFile[] = [];
  for (const f of siblings) {
    const kind = inferKind(f.name);
    if (kind === null) continue;
    out.push({
      name: f.name,
      path: f.path,
      relPath: f.name,
      raw: f.raw,
      ast: parseForKind(kind, f.raw),
    });
  }
  return out;
}

async function regenerateIR(
  siblings: readonly { name: string; path: string; raw: string }[],
): Promise<PolicyIR | null> {
  const spec = getPolicyGenerator(GENERATOR_ID);
  if (spec === null) return null;
  const files = extractFilesFromSiblings(siblings);
  // Synthetic anchor — drift detection compares SHAPE hash, which
  // excludes generatedFrom; the anchor only flows into provenance.
  const anchor = {
    hash: '0'.repeat(64),
    bytes: files.reduce((n, f) => n + f.raw.length, 0),
    observedAt: new Date().toISOString(),
  };
  const input: MdGeneratorInput = { files };
  return await spec.generator.generate(
    input as unknown as Parameters<typeof spec.generator.generate>[0],
    anchor,
  );
}

export const policyRegenerateOnDrift: OcPathFixerSpec = {
  id: 'policy-starter-v0/policy/regenerate-on-drift',
  description:
    'Regenerate policy.jsonc from sources when its shape hash drifts from what the generator would produce',
  severity: 'error',
  // Regenerative — wrong regen on a security-sensitive artifact can
  // produce a fail-closed policy that locks out tools across the
  // fleet. Hosts MUST gate this behind explicit operator opt-in
  // (e.g., `--fix-regenerative`).
  tier: 'regenerative',
  appliesTo: 'policy.jsonc',

  async detect({ raw, siblingFiles }) {
    if (siblingFiles === undefined) return [];
    let onDisk: PolicyIR;
    try {
      onDisk = JSON.parse(raw) as PolicyIR;
    } catch {
      return []; // not parseable — separate concern
    }
    const onDiskShape = computePolicyShapeHash(onDisk);
    const regenerated = await regenerateIR(siblingFiles);
    if (regenerated === null) return []; // no generator
    const regenShape = computePolicyShapeHash(regenerated);
    if (onDiskShape === regenShape) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://policy.jsonc'),
          match: { kind: 'insertion-point' as const, container: 'jsonc-object' as const, line: 1 },
        },
        message: `policy.jsonc shape (${onDiskShape.slice(0, 8)}…) drifts from regenerated (${regenShape.slice(0, 8)}…)`,
        fixHint: 'regenerate policy.jsonc from sources',
      },
    ];
  },

  async fix({ raw, siblingFiles }) {
    if (siblingFiles === undefined) return raw;
    const regenerated = await regenerateIR(siblingFiles);
    if (regenerated === null) return raw;
    return JSON.stringify(regenerated, null, 2) + '\n';
  },
};
