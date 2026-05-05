/**
 * Wave 8 — JSONL starter fixer pack adversarial scenarios.
 */
import { parseJsonl } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  jsonlStarterFixers,
  sessionAppendTerminalEvent,
  sessionQuarantineMalformedLine,
} from '../../src/extensions/ocdoctor-fixers-jsonl-starter/index.js';
import type { OcPathFixerSpec } from '../../src/plugin-sdk/oc-doctor/types.js';

async function applyFix(
  spec: OcPathFixerSpec<unknown>,
  raw: string,
  fileName = 'session.jsonl',
): Promise<string> {
  const ast = parseJsonl(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({
    fileName,
    ast,
    raw,
    match: matches[0]!.match,
  });
}

const HOSTILE_INPUTS: string[] = [
  '',
  '\n',
  '\n\n\n',
  'broken\n',
  'a\nb\nc\n',
  '{"a":1}\n',
  '{"event":"start"}\n',
  '{"event":"start"}\n{"event":"end"}\n',
  '{"event":"start"}\nbroken\n{"event":"end"}\n',
  '\n{"event":"a"}\n',
  '{"event":"a"}\n\n\n',
  '{}\n',
  '"string"\n',
  '[1,2]\n',
];

describe('wave-08 jsonl fixers — idempotency', () => {
  for (const fixer of jsonlStarterFixers) {
    describe(fixer.id, () => {
      for (const raw of HOSTILE_INPUTS) {
        const label = JSON.stringify(raw.slice(0, 30));
        it(`is idempotent on ${label}`, async () => {
          const once = await applyFix(fixer, raw);
          const twice = await applyFix(fixer, once);
          expect(twice).toBe(once);
        });
      }
    });
  }
});

describe('wave-08 jsonl fixers — hostile inputs do not throw', () => {
  for (const fixer of jsonlStarterFixers) {
    for (const raw of HOSTILE_INPUTS) {
      it(`${fixer.id} does not throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => applyFix(fixer, raw)).not.toThrow();
      });
    }
  }
});

describe('wave-08 append-terminal-event — semantic correctness', () => {
  it('appends only when last event is non-terminal', async () => {
    const before = '{"event":"step"}\n';
    const after = await applyFix(sessionAppendTerminalEvent, before);
    expect(after).toContain('"event":"end"');
    expect(after).toContain('"_auto":true');
  });

  it('preserves prior lines verbatim', async () => {
    const before = '{"event":"start"}\n{"event":"step","n":42}\n';
    const after = await applyFix(sessionAppendTerminalEvent, before);
    expect(after.startsWith(before)).toBe(true);
  });

  it('trailing-newline shape is preserved (file ends with \\n)', async () => {
    const before = '{"event":"step"}\n';
    const after = await applyFix(sessionAppendTerminalEvent, before);
    expect(after.endsWith('\n')).toBe(true);
  });

  it('handles file without trailing newline', async () => {
    const before = '{"event":"step"}';
    const after = await applyFix(sessionAppendTerminalEvent, before);
    expect(after).toContain('"event":"end"');
  });

  it('no-op when last event is already terminal', async () => {
    for (const term of ['end', 'complete', 'finalized', 'done']) {
      const before = `{"event":"${term}"}\n`;
      expect(await applyFix(sessionAppendTerminalEvent, before)).toBe(before);
    }
  });
});

describe('wave-08 quarantine-malformed-line — semantic correctness', () => {
  it('replaces only malformed lines, preserves value lines', async () => {
    const before = '{"event":"start"}\nbroken\n{"event":"end"}\n';
    const after = await applyFix(sessionQuarantineMalformedLine, before);
    const lines = after.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ event: 'start' });
    expect(JSON.parse(lines[1] ?? '').event).toBe('malformed');
    expect(JSON.parse(lines[1] ?? '').original).toBe('broken');
    expect(JSON.parse(lines[2] ?? '')).toEqual({ event: 'end' });
  });

  it('preserves blank lines verbatim', async () => {
    const before = '{"a":1}\n\nbroken\n\n{"b":2}\n';
    const after = await applyFix(sessionQuarantineMalformedLine, before);
    const lines = after.split('\n');
    expect(lines[1]).toBe('');
    expect(lines[3]).toBe('');
  });

  it('handles all-malformed file', async () => {
    const before = 'a\nb\nc\n';
    const after = await applyFix(sessionQuarantineMalformedLine, before);
    const lines = after.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const obj = JSON.parse(lines[i] ?? '');
      expect(obj.event).toBe('malformed');
    }
  });

  it('preserves original content character-for-character', async () => {
    const malformed = '!@#$%^&*()  custom <text>';
    const before = `{"a":1}\n${malformed}\n`;
    const after = await applyFix(sessionQuarantineMalformedLine, before);
    const lines = after.split('\n').filter((l) => l.length > 0);
    const quarantine = JSON.parse(lines[1] ?? '');
    expect(quarantine.original).toBe(malformed);
  });
});

describe('wave-08 jsonl fixers — pack invariants', () => {
  it('exports 2 fixers', () => {
    expect(jsonlStarterFixers).toHaveLength(2);
  });
  it('all apply to jsonl files', () => {
    for (const f of jsonlStarterFixers) expect(f.appliesTo).toMatch(/jsonl/);
  });
  it('all ids unique', () => {
    const ids = jsonlStarterFixers.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('wave-08 jsonl fixers — large session simulation', () => {
  it('quarantine fixer handles 500 mixed lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(i % 7 === 0 ? `broken-${i}` : JSON.stringify({ event: 'step', n: i }));
    }
    const raw = lines.join('\n') + '\n';
    expect(() => applyFix(sessionQuarantineMalformedLine, raw)).not.toThrow();
  });
});
