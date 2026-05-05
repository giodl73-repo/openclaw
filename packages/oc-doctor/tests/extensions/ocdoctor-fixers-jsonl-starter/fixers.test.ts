import { parseJsonl } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  jsonlStarterFixers,
  sessionAppendTerminalEvent,
  sessionQuarantineMalformedLine,
} from '../../../src/extensions/ocdoctor-fixers-jsonl-starter/index.js';
import { syntheticMatch } from '../../test-match.js';

async function detect(spec: typeof sessionAppendTerminalEvent, raw: string, fileName = 'session.jsonl') {
  return await spec.detect({ fileName, ast: parseJsonl(raw).ast, raw });
}
async function fix(spec: typeof sessionAppendTerminalEvent, raw: string, fileName = 'session.jsonl') {
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

describe('sessionAppendTerminalEvent', () => {
  it('detects non-terminal final event', async () => {
    expect(
      (await detect(sessionAppendTerminalEvent, '{"event":"start"}\n{"event":"step"}\n')).length,
    ).toBe(1);
  });
  it('does not detect when last event is end', async () => {
    expect(
      (await detect(sessionAppendTerminalEvent, '{"event":"start"}\n{"event":"end"}\n')).length,
    ).toBe(0);
  });
  it('appends terminal event with _auto marker', async () => {
    const after = await fix(sessionAppendTerminalEvent, '{"event":"step"}\n');
    expect(after).toContain('"event":"end"');
    expect(after).toContain('"_auto":true');
  });
  it('preserves prior lines verbatim', async () => {
    const before = '{"event":"start"}\n{"event":"step","n":42}\n';
    const after = await fix(sessionAppendTerminalEvent, before);
    expect(after.startsWith(before)).toBe(true);
  });
  it('is idempotent', async () => {
    const once = await fix(sessionAppendTerminalEvent, '{"event":"step"}\n');
    const twice = await fix(sessionAppendTerminalEvent, once);
    expect(twice).toBe(once);
  });
  it('no-ops on empty file', async () => {
    expect(await fix(sessionAppendTerminalEvent, '')).toBe('');
  });
  it('no-ops on file ending with already-terminal event', async () => {
    const before = '{"event":"start"}\n{"event":"complete"}\n';
    expect(await fix(sessionAppendTerminalEvent, before)).toBe(before);
  });
});

describe('sessionQuarantineMalformedLine', () => {
  it('detects malformed lines individually', async () => {
    expect(
      (await detect(
        sessionQuarantineMalformedLine,
        '{"event":"start"}\nbroken1\n{"event":"end"}\nbroken2\n',
      )).length,
    ).toBe(2);
  });
  it('passes a clean log', async () => {
    expect(
      (await detect(sessionQuarantineMalformedLine, '{"event":"start"}\n{"event":"end"}\n'))
        .length,
    ).toBe(0);
  });
  it('replaces malformed lines with quarantine events preserving original', async () => {
    const after = await fix(
      sessionQuarantineMalformedLine,
      '{"event":"start"}\nbroken1\n{"event":"end"}\n',
    );
    const lines = after.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const quarantine = JSON.parse(lines[1] ?? '');
    expect(quarantine.event).toBe('malformed');
    expect(quarantine.original).toBe('broken1');
    expect(quarantine._auto).toBe(true);
  });
  it('is idempotent — re-running on quarantined file is a no-op', async () => {
    const once = await fix(
      sessionQuarantineMalformedLine,
      '{"event":"start"}\nbroken\n{"event":"end"}\n',
    );
    const twice = await fix(sessionQuarantineMalformedLine, once);
    expect(twice).toBe(once);
  });
  it('preserves blank lines and value lines', async () => {
    const before = '{"event":"a"}\n\nbroken\n\n{"event":"b"}\n';
    const after = await fix(sessionQuarantineMalformedLine, before);
    const lines = after.split('\n');
    expect(lines[0]).toBe('{"event":"a"}');
    expect(lines[1]).toBe(''); // blank preserved
    expect(JSON.parse(lines[2] ?? '').event).toBe('malformed');
    expect(lines[3]).toBe(''); // blank preserved
    expect(lines[4]).toBe('{"event":"b"}');
  });
});

describe('jsonlStarterFixers — pack registration', () => {
  it('exports 2 fixers', () => {
    expect(jsonlStarterFixers).toHaveLength(2);
  });
  it('all share the jsonl kind discriminator', () => {
    for (const f of jsonlStarterFixers) {
      expect(f.appliesTo).toMatch(/jsonl/);
    }
  });
});
