/**
 * Tests for `policy-lint-rules-starter` — the 6 TOOLS.md rules
 * shipping in the canonical policy plugin pack.
 */
import { parseMd } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  toolsDuplicateToolId,
  toolsIrreversibleLowRiskMismatch,
  toolsLegacySensitivitySyntax,
  toolsMissingRiskLevel,
  toolsUnknownRiskLevel,
  toolsUnknownSensitivityToken,
} from '../../../src/extensions/policy-lint-rules-starter/index.js';

function check(rule: { check: (ctx: { fileName: string; ast: ReturnType<typeof parseMd>['ast'] }) => readonly { ruleId?: string; message: string; line: number }[] }, raw: string, fileName = 'TOOLS.md') {
  const ast = parseMd(raw).ast;
  return rule.check({ fileName, ast });
}

describe('toolsLegacySensitivitySyntax', () => {
  it('PL-LSS-01 flags bare-word `public`', () => {
    const findings = check(
      toolsLegacySensitivitySyntax,
      '## Tools\n### t # R3, READ, public\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/legacy bare-word sensitivity 'public'/);
  });

  it('PL-LSS-02 does NOT flag canonical `sensitivity:public`', () => {
    const findings = check(
      toolsLegacySensitivitySyntax,
      '## Tools\n### t # R3, READ, sensitivity:public\n',
    );
    expect(findings).toEqual([]);
  });

  it('PL-LSS-03 does NOT flag tools without any sensitivity token', () => {
    const findings = check(
      toolsLegacySensitivitySyntax,
      '## Tools\n### t # R3, READ\n',
    );
    expect(findings).toEqual([]);
  });

  it('PL-LSS-04 does NOT match `public-api` substring inside other tokens', () => {
    // The bare-word match is token-level, so `public-api` doesn't trigger.
    const findings = check(
      toolsLegacySensitivitySyntax,
      '## Tools\n### t # R3, public-api-helper\n',
    );
    expect(findings).toEqual([]);
  });
});

describe('toolsUnknownSensitivityToken', () => {
  it('PL-UST-01 flags `sensitivity:bogus`', () => {
    const findings = check(
      toolsUnknownSensitivityToken,
      '## Tools\n### t # R3, READ, sensitivity:bogus\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/unknown sensitivity 'bogus'/);
  });

  it('PL-UST-02 does NOT flag known levels', () => {
    for (const level of ['public', 'internal', 'confidential', 'restricted']) {
      const findings = check(
        toolsUnknownSensitivityToken,
        `## Tools\n### t # R3, READ, sensitivity:${level}\n`,
      );
      expect(findings).toEqual([]);
    }
  });

  it('PL-UST-03 does NOT flag bare-word legacy form', () => {
    // That's the legacy-sensitivity-syntax rule's job, not this one.
    const findings = check(
      toolsUnknownSensitivityToken,
      '## Tools\n### t # R3, READ, public\n',
    );
    expect(findings).toEqual([]);
  });
});

describe('toolsMissingRiskLevel', () => {
  it('PL-MRL-01 flags tool with meta but no R<n>', () => {
    const findings = check(
      toolsMissingRiskLevel,
      '## Tools\n### t # READ, COMMUNICATE\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/no R<n> risk token/);
  });

  it('PL-MRL-02 does NOT flag tool with R<n>', () => {
    const findings = check(
      toolsMissingRiskLevel,
      '## Tools\n### t # R3, READ\n',
    );
    expect(findings).toEqual([]);
  });

  it('PL-MRL-03 does NOT flag tool without any meta line', () => {
    // Tool with no meta is a different concern (extractor skips).
    const findings = check(
      toolsMissingRiskLevel,
      '## Tools\n### t\n',
    );
    expect(findings).toEqual([]);
  });
});

describe('toolsUnknownRiskLevel', () => {
  it('PL-URL-01 flags R7 (out of range)', () => {
    const findings = check(
      toolsUnknownRiskLevel,
      '## Tools\n### t # R7, READ\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/out-of-range risk 'R7'/);
  });

  it('PL-URL-02 flags R-1 (negative)', () => {
    const findings = check(
      toolsUnknownRiskLevel,
      '## Tools\n### t # R-1, READ\n',
    );
    expect(findings).toHaveLength(1);
  });

  it('PL-URL-03 does NOT flag R0..R5', () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const findings = check(
        toolsUnknownRiskLevel,
        `## Tools\n### t # R${n}, READ\n`,
      );
      expect(findings).toEqual([]);
    }
  });
});

describe('toolsIrreversibleLowRiskMismatch', () => {
  it('PL-ILRM-01 flags IRREVERSIBLE_EXTERNAL with R0..R3', () => {
    for (const n of [0, 1, 2, 3]) {
      const findings = check(
        toolsIrreversibleLowRiskMismatch,
        `## Tools\n### t # R${n}, IRREVERSIBLE_EXTERNAL\n`,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toMatch(/IRREVERSIBLE_EXTERNAL/);
    }
  });

  it('PL-ILRM-02 does NOT flag IRREVERSIBLE_EXTERNAL with R4 or R5', () => {
    for (const n of [4, 5]) {
      const findings = check(
        toolsIrreversibleLowRiskMismatch,
        `## Tools\n### t # R${n}, IRREVERSIBLE_EXTERNAL\n`,
      );
      expect(findings).toEqual([]);
    }
  });

  it('PL-ILRM-03 does NOT flag low-risk WITHOUT IRREVERSIBLE_EXTERNAL', () => {
    const findings = check(
      toolsIrreversibleLowRiskMismatch,
      '## Tools\n### t # R0, READ\n',
    );
    expect(findings).toEqual([]);
  });
});

describe('toolsDuplicateToolId', () => {
  it('PL-DTI-01 flags second occurrence of duplicated id', () => {
    const findings = check(
      toolsDuplicateToolId,
      '## Tools\n### t # R3, READ\n### t # R5, WRITE\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/declared more than once/);
  });

  it('PL-DTI-02 does NOT flag distinct ids', () => {
    const findings = check(
      toolsDuplicateToolId,
      '## Tools\n### a # R3, READ\n### b # R5, WRITE\n',
    );
    expect(findings).toEqual([]);
  });

  it('PL-DTI-03 flags both 2nd and 3rd occurrence on triplicate', () => {
    const findings = check(
      toolsDuplicateToolId,
      '## Tools\n### t # R1, READ\n### t # R3, WRITE\n### t # R5, COMMUNICATE\n',
    );
    expect(findings).toHaveLength(2);
  });
});
