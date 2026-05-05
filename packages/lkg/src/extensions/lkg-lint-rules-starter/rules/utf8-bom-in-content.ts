/**
 * Rule: `lkg-starter-v0/lkg/utf8-bom-in-content`
 * Severity: info
 * Applies to: any canonical workspace file
 *
 * Flag: file content starts with the UTF-8 BOM (EF BB BF / U+FEFF).
 * The LKG store observes the bytes verbatim — fingerprint includes
 * the BOM. Downstream tools may strip BOMs silently, producing
 * "fingerprint matches but live bytes don't" surprises during
 * recovery. Flagging at lint time lets operators normalize.
 *
 * Paired fixer: `lkg/strip-utf8-bom` removes the leading BOM bytes.
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';

const BOM = '﻿';

export const utf8BomInContent: LintRule = {
  id: 'lkg-starter-v0/lkg/utf8-bom-in-content',
  severity: 'info',
  description:
    'File content starts with UTF-8 BOM (U+FEFF); recovery may produce surprising fingerprints',
  appliesTo: '*',
  check(ctx) {
    const findings: LintFinding[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (ctx.ast as any).raw as string | undefined;
    if (typeof raw !== 'string') return findings;
    if (!raw.startsWith(BOM)) return findings;
    findings.push({
      message: `${ctx.fileName} starts with UTF-8 BOM; downstream tools may strip silently, breaking fingerprint comparisons`,
      ocPath: `oc://${ctx.fileName}`,
      line: 1,
      fixHint: 'strip the leading BOM byte (U+FEFF)',
    });
    return findings;
  },
};
