/**
 * Tests for `lkg-lint-rules-starter` — three rules covering pre-
 * observe failure surfaces.
 */
import { parseMd, REDACTED_SENTINEL } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  emptyTrackedFile,
  sentinelInContent,
  utf8BomInContent,
} from '../../../src/extensions/lkg-lint-rules-starter/index.js';

function check(rule: typeof sentinelInContent, raw: string, fileName = 'AGENTS.md') {
  const ast = parseMd(raw).ast;
  return rule.check({ fileName, ast });
}

describe('sentinelInContent', () => {
  it('LL-SIC-01 flags content containing the sentinel', () => {
    const findings = check(
      sentinelInContent,
      `## H\nfoo ${REDACTED_SENTINEL} bar\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('__OPENCLAW_REDACTED__');
  });

  it('LL-SIC-02 does NOT flag clean content', () => {
    const findings = check(sentinelInContent, '## H\nclean\n');
    expect(findings).toEqual([]);
  });

  it('LL-SIC-03 reports the line of the first occurrence', () => {
    const findings = check(
      sentinelInContent,
      `## H\nline 2\nline 3 ${REDACTED_SENTINEL}\n`,
    );
    expect(findings[0]?.line).toBe(3);
  });
});

describe('emptyTrackedFile', () => {
  it('LL-ETF-01 flags empty AGENTS.md', () => {
    const findings = check(emptyTrackedFile, '');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/empty/i);
  });

  it('LL-ETF-02 flags whitespace-only content', () => {
    const findings = check(emptyTrackedFile, '   \n\t\n');
    expect(findings).toHaveLength(1);
  });

  it('LL-ETF-03 does NOT flag content with substantive bytes', () => {
    const findings = check(emptyTrackedFile, '## Boundaries\n- never\n');
    expect(findings).toEqual([]);
  });

  it('LL-ETF-04 has appliesTo glob covering all canonical core md files', () => {
    expect(emptyTrackedFile.appliesTo).toContain('AGENTS.md');
    expect(emptyTrackedFile.appliesTo).toContain('SOUL.md');
    expect(emptyTrackedFile.appliesTo).toContain('TOOLS.md');
  });
});

describe('utf8BomInContent', () => {
  it('LL-UBOM-01 flags content starting with BOM', () => {
    const findings = check(utf8BomInContent, '\u{FEFF}## H\n');
    expect(findings).toHaveLength(1);
  });

  it('LL-UBOM-02 does NOT flag BOM-free content', () => {
    const findings = check(utf8BomInContent, '## H\n');
    expect(findings).toEqual([]);
  });

  it('LL-UBOM-03 does NOT flag BOM bytes appearing mid-content', () => {
    // BOM at line 2 isn't a leading BOM; the rule only flags LEADING.
    const findings = check(utf8BomInContent, '## H\n\u{FEFF}foo\n');
    expect(findings).toEqual([]);
  });
});
