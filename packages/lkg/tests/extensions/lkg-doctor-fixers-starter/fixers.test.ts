/**
 * Tests for `lkg-doctor-fixers-starter` — paired auto-fixers for
 * the LKG lint rules.
 */
import { parseMd, REDACTED_SENTINEL } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  scrubSentinelFromTracked,
  stripUtf8Bom,
} from '../../../src/extensions/lkg-doctor-fixers-starter/index.js';

async function detectAndFix(
  spec: typeof scrubSentinelFromTracked,
  raw: string,
  fileName = 'AGENTS.md',
): Promise<string> {
  const ast = parseMd(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({ fileName, ast, raw, match: matches[0]!.match });
}

describe('scrubSentinelFromTracked', () => {
  it('LD-SST-01 replaces sentinel with [REDACTED]', async () => {
    const before = `## H\nfoo ${REDACTED_SENTINEL} bar\n`;
    const after = await detectAndFix(scrubSentinelFromTracked, before);
    expect(after).not.toContain(REDACTED_SENTINEL);
    expect(after).toContain('[REDACTED]');
  });

  it('LD-SST-02 idempotent on clean content', async () => {
    const before = '## H\nclean\n';
    const after = await detectAndFix(scrubSentinelFromTracked, before);
    expect(after).toBe(before);
  });

  it('LD-SST-03 replaces every occurrence (multi-hit)', async () => {
    const before = `${REDACTED_SENTINEL} a ${REDACTED_SENTINEL} b ${REDACTED_SENTINEL}`;
    const after = await detectAndFix(scrubSentinelFromTracked, before);
    expect(after).not.toContain(REDACTED_SENTINEL);
    expect(after.split('[REDACTED]')).toHaveLength(4); // 3 replacements
  });

  it('LD-SST-04 idempotent — re-running on already-scrubbed input is no-op', async () => {
    const before = `## H\nfoo ${REDACTED_SENTINEL} bar\n`;
    const once = await detectAndFix(scrubSentinelFromTracked, before);
    const twice = await detectAndFix(scrubSentinelFromTracked, once);
    expect(twice).toBe(once);
  });
});

describe('stripUtf8Bom', () => {
  it('LD-BOM-01 strips leading BOM', async () => {
    const before = '\u{FEFF}## H\n';
    const after = await detectAndFix(stripUtf8Bom, before);
    expect(after).toBe('## H\n');
    expect(after.startsWith('\u{FEFF}')).toBe(false);
  });

  it('LD-BOM-02 idempotent on BOM-free content', async () => {
    const before = '## H\n';
    const after = await detectAndFix(stripUtf8Bom, before);
    expect(after).toBe(before);
  });

  it('LD-BOM-03 does NOT strip mid-content BOM bytes', async () => {
    // Only the LEADING BOM is removed; BOM at offset > 0 is preserved.
    const before = '## H\n\u{FEFF}foo\n';
    const after = await detectAndFix(stripUtf8Bom, before);
    expect(after).toBe(before);
  });
});
