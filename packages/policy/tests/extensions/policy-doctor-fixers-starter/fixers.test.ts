/**
 * Tests for `policy-doctor-fixers-starter` — paired auto-fixers
 * for the policy lint rules + cross-file drift regeneration.
 *
 * Each fixer is exercised through the canonical
 * `OcPathFixerSpec.detect → fix` cycle. The drift fixer also
 * exercises the new `siblingFiles` cross-file surface.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  policyRegenerateOnDrift,
  toolsBumpRiskOnIrreversible,
  toolsDedupeToolId,
  toolsMigrateSensitivitySyntax,
  toolsRecommendRiskFromCaps,
  toolsSnapRiskLevel,
  toolsSnapSensitivityToken,
} from '../../../src/extensions/policy-doctor-fixers-starter/index.js';

async function detectAndFix(
  spec:
    | typeof toolsMigrateSensitivitySyntax
    | typeof toolsRecommendRiskFromCaps
    | typeof toolsBumpRiskOnIrreversible
    | typeof toolsSnapRiskLevel
    | typeof toolsSnapSensitivityToken
    | typeof toolsDedupeToolId,
  raw: string,
  fileName = 'TOOLS.md',
): Promise<string> {
  const ast = parseMd(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({ fileName, ast, raw, match: matches[0]!.match });
}

describe('toolsMigrateSensitivitySyntax', () => {
  it('PD-MSS-01 rewrites bare-word public → sensitivity:public', async () => {
    const after = await detectAndFix(
      toolsMigrateSensitivitySyntax,
      '## Tools\n### t # R3, READ, public\n',
    );
    expect(after).toContain('sensitivity:public');
    expect(after).not.toMatch(/, public[^:]/);
  });

  it('PD-MSS-02 idempotent on already-canonical input', async () => {
    const before = '## Tools\n### t # R3, READ, sensitivity:public\n';
    const after = await detectAndFix(toolsMigrateSensitivitySyntax, before);
    expect(after).toBe(before);
  });
});

describe('toolsRecommendRiskFromCaps', () => {
  it('PD-RRC-01 inserts R5 for IRREVERSIBLE_EXTERNAL', async () => {
    const after = await detectAndFix(
      toolsRecommendRiskFromCaps,
      '## Tools\n### t # COMMUNICATE, IRREVERSIBLE_EXTERNAL\n',
    );
    expect(after).toMatch(/### t # R5, /);
  });

  it('PD-RRC-02 inserts R4 for FLEET_PRIVILEGED', async () => {
    const after = await detectAndFix(
      toolsRecommendRiskFromCaps,
      '## Tools\n### t # FLEET_PRIVILEGED\n',
    );
    expect(after).toMatch(/### t # R4, /);
  });

  it('PD-RRC-03 inserts R3 for COMMUNICATE/WRITE', async () => {
    const after = await detectAndFix(
      toolsRecommendRiskFromCaps,
      '## Tools\n### t # WRITE\n',
    );
    expect(after).toMatch(/### t # R3, /);
  });

  it('PD-RRC-04 defaults to R1 for READ-only', async () => {
    const after = await detectAndFix(
      toolsRecommendRiskFromCaps,
      '## Tools\n### t # READ\n',
    );
    expect(after).toMatch(/### t # R1, /);
  });

  it('PD-RRC-05 idempotent — R<n> already present means no-op', async () => {
    const before = '## Tools\n### t # R3, READ\n';
    const after = await detectAndFix(toolsRecommendRiskFromCaps, before);
    expect(after).toBe(before);
  });
});

describe('toolsBumpRiskOnIrreversible', () => {
  it('PD-BRI-01 bumps R0 → R4 when paired with IRREVERSIBLE_EXTERNAL', async () => {
    const after = await detectAndFix(
      toolsBumpRiskOnIrreversible,
      '## Tools\n### t # R0, IRREVERSIBLE_EXTERNAL\n',
    );
    expect(after).toContain('R4');
    expect(after).not.toContain('R0');
  });

  it('PD-BRI-02 idempotent on R5 + IRREVERSIBLE', async () => {
    const before = '## Tools\n### t # R5, IRREVERSIBLE_EXTERNAL\n';
    const after = await detectAndFix(toolsBumpRiskOnIrreversible, before);
    expect(after).toBe(before);
  });

  it('PD-BRI-03 no-op without IRREVERSIBLE_EXTERNAL', async () => {
    const before = '## Tools\n### t # R0, READ\n';
    const after = await detectAndFix(toolsBumpRiskOnIrreversible, before);
    expect(after).toBe(before);
  });
});

describe('toolsSnapSensitivityToken', () => {
  it('PD-SST-01 snaps `sensitivity:bogus` to default `internal`', async () => {
    const after = await detectAndFix(
      toolsSnapSensitivityToken,
      '## Tools\n### t # R3, READ, sensitivity:bogus\n',
    );
    expect(after).toContain('sensitivity:internal');
    expect(after).not.toContain('bogus');
  });

  it('PD-SST-02 idempotent on already-known level', async () => {
    const before = '## Tools\n### t # R3, READ, sensitivity:public\n';
    const after = await detectAndFix(toolsSnapSensitivityToken, before);
    expect(after).toBe(before);
  });
});

describe('toolsSnapRiskLevel', () => {
  it('PD-SRL-01 snaps R7 → R5', async () => {
    const after = await detectAndFix(
      toolsSnapRiskLevel,
      '## Tools\n### t # R7, READ\n',
    );
    expect(after).toContain('R5');
    expect(after).not.toContain('R7');
  });

  it('PD-SRL-02 snaps R-1 → R0', async () => {
    const after = await detectAndFix(
      toolsSnapRiskLevel,
      '## Tools\n### t # R-1, READ\n',
    );
    expect(after).toContain('R0');
    expect(after).not.toContain('R-1');
  });

  it('PD-SRL-03 idempotent on in-range', async () => {
    const before = '## Tools\n### t # R3, READ\n';
    const after = await detectAndFix(toolsSnapRiskLevel, before);
    expect(after).toBe(before);
  });
});

describe('toolsDedupeToolId', () => {
  it('PD-DTI-01 removes the earlier duplicate, keeps the last', async () => {
    const after = await detectAndFix(
      toolsDedupeToolId,
      '## Tools\n### t # R1, READ\n### t # R5, WRITE\n',
    );
    // After dedupe, the first `### t # R1, READ` block is gone.
    const occurrences = (after.match(/### t /g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(after).toMatch(/### t # R5, WRITE/);
  });

  it('PD-DTI-02 no-op on distinct ids', async () => {
    const before = '## Tools\n### a # R1, READ\n### b # R5, WRITE\n';
    const after = await detectAndFix(toolsDedupeToolId, before);
    expect(after).toBe(before);
  });
});

describe('policyRegenerateOnDrift — cross-file fixer using siblingFiles', () => {
  // Fixture: a workspace where TOOLS.md has changed since policy.jsonc
  // was generated. The fixer's detect() reads siblingFiles to regenerate
  // and compare shape hashes; fix() rewrites policy.jsonc.

  const TOOLS_BEFORE = '## Tools\n### t # R1, READ\n';
  const TOOLS_AFTER = '## Tools\n### t # R1, READ\n### added # R3, WRITE\n';
  const SOUL = '## Boundaries\n- never bypass\n';

  // A pre-computed policy.jsonc that was generated from TOOLS_BEFORE +
  // SOUL — its shape hash will NOT match what regeneration from
  // TOOLS_AFTER + SOUL produces.
  function buildSiblings(toolsRaw: string): readonly { name: string; path: string; raw: string; ast: ReturnType<typeof parseMd>['ast'] }[] {
    return [
      { name: 'TOOLS.md', path: '/ws/TOOLS.md', raw: toolsRaw, ast: parseMd(toolsRaw).ast },
      { name: 'SOUL.md', path: '/ws/SOUL.md', raw: SOUL, ast: parseMd(SOUL).ast },
    ];
  }

  async function generatePolicyJsonFromSources(toolsRaw: string): Promise<string> {
    // Use the regenerate-on-drift fixer's own logic by treating an
    // empty placeholder as the on-disk policy and letting fix() return
    // the regenerated bytes — that exercises the same code path.
    const placeholder = JSON.stringify({
      version: '0.1.0',
      policyId: '0'.repeat(64),
      generatedAt: new Date().toISOString(),
      generatedFrom: { hash: '0'.repeat(64), bytes: 0, observedAt: new Date().toISOString() },
      tools: [],
      denyRules: [],
    });
    const ast = { kind: 'jsonc' as const, raw: placeholder } as unknown as ReturnType<typeof parseMd>['ast'];
    return await policyRegenerateOnDrift.fix({
      fileName: 'policy.jsonc',
      ast,
      raw: placeholder,
      match: {
        path: { segments: [] } as never,
        match: { kind: 'insertion-point' as const, container: 'jsonc-object' as const, line: 1 },
      } as never,
      siblingFiles: buildSiblings(toolsRaw),
    });
  }

  it('PD-DRIFT-01 detects drift when sources change', async () => {
    const inSyncPolicy = await generatePolicyJsonFromSources(TOOLS_BEFORE);
    // Now ask: "given the same in-sync policy bytes, but with sibling
    // files representing the AFTER state, does detect see drift?"
    const ast = parseMd(inSyncPolicy).ast; // ast doesn't matter for this fixer
    const findings = await policyRegenerateOnDrift.detect({
      fileName: 'policy.jsonc',
      ast,
      raw: inSyncPolicy,
      siblingFiles: buildSiblings(TOOLS_AFTER),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/drifts/);
  });

  it('PD-DRIFT-02 no drift when sources match the on-disk policy', async () => {
    const inSyncPolicy = await generatePolicyJsonFromSources(TOOLS_BEFORE);
    const ast = parseMd(inSyncPolicy).ast;
    const findings = await policyRegenerateOnDrift.detect({
      fileName: 'policy.jsonc',
      ast,
      raw: inSyncPolicy,
      siblingFiles: buildSiblings(TOOLS_BEFORE),
    });
    expect(findings).toEqual([]);
  });

  it('PD-DRIFT-03 detect returns [] when siblingFiles is undefined', async () => {
    const findings = await policyRegenerateOnDrift.detect({
      fileName: 'policy.jsonc',
      ast: parseMd('').ast,
      raw: '{}',
    });
    expect(findings).toEqual([]);
  });

  it('PD-DRIFT-04 fix() returns regenerated bytes containing the updated tool', async () => {
    const ast = parseMd('').ast;
    const after = await policyRegenerateOnDrift.fix({
      fileName: 'policy.jsonc',
      ast,
      raw: '{}',
      match: {
        path: { segments: [] } as never,
        match: { kind: 'insertion-point' as const, container: 'jsonc-object' as const, line: 1 },
      } as never,
      siblingFiles: buildSiblings(TOOLS_AFTER),
    });
    const ir = JSON.parse(after);
    expect(ir.tools.map((t: { id: string }) => t.id)).toContain('added');
  });
});
