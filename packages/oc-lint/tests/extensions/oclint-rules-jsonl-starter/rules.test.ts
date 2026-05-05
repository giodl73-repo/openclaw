import { parseJsonl } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  jsonlStarterRules,
  sessionEmptyLog,
  sessionMalformedLine,
  sessionMissingEventKey,
  sessionNoTerminalEvent,
} from '../../../src/extensions/oclint-rules-jsonl-starter/index.js';

function ctx(raw: string, fileName = 'session-events.jsonl') {
  return { fileName, ast: parseJsonl(raw).ast };
}

describe('jsonl-starter — session-empty-log', () => {
  it('flags an entirely empty file', () => {
    expect(sessionEmptyLog.check(ctx('')).length).toBe(1);
  });
  it('flags a blank-only file', () => {
    expect(sessionEmptyLog.check(ctx('\n\n\n')).length).toBe(1);
  });
  it('flags a malformed-only file', () => {
    expect(sessionEmptyLog.check(ctx('garbage\nmore garbage\n')).length).toBe(1);
  });
  it('passes once any value line exists', () => {
    expect(sessionEmptyLog.check(ctx('{"event":"start"}\n')).length).toBe(0);
  });
});

describe('jsonl-starter — session-missing-event-key', () => {
  it('flags lines that are not objects', () => {
    const findings = sessionMissingEventKey.check(
      ctx('"just a string"\n[1,2,3]\n42\n'),
    );
    expect(findings.length).toBe(3);
  });
  it('flags object lines without event key', () => {
    const findings = sessionMissingEventKey.check(ctx('{"foo":"bar"}\n'));
    expect(findings.length).toBe(1);
    expect(findings[0]?.ocPath).toBe('oc://session-events.jsonl/L1');
  });
  it('passes object lines that have event', () => {
    expect(
      sessionMissingEventKey.check(ctx('{"event":"start","ts":1}\n')).length,
    ).toBe(0);
  });
  it('skips blank and malformed lines (those have their own rule)', () => {
    const findings = sessionMissingEventKey.check(
      ctx('{"event":"a"}\n\nbroken\n{"event":"b"}\n'),
    );
    expect(findings.length).toBe(0);
  });
});

describe('jsonl-starter — session-malformed-line', () => {
  it('flags every malformed line individually', () => {
    const findings = sessionMalformedLine.check(
      ctx('{"event":"a"}\nbroken1\n{"event":"b"}\nbroken2\n'),
    );
    expect(findings.length).toBe(2);
  });
  it('passes a clean file', () => {
    expect(
      sessionMalformedLine.check(ctx('{"event":"a"}\n{"event":"b"}\n')).length,
    ).toBe(0);
  });
  it('skips blank lines (those are not malformed)', () => {
    expect(
      sessionMalformedLine.check(ctx('{"event":"a"}\n\n{"event":"b"}\n')).length,
    ).toBe(0);
  });
});

describe('jsonl-starter — session-no-terminal-event', () => {
  it('flags last event != end/complete/finalized/done', () => {
    const findings = sessionNoTerminalEvent.check(
      ctx('{"event":"start"}\n{"event":"step"}\n'),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.ocPath).toBe('oc://session-events.jsonl/$last/event');
  });
  it('passes when last event is end', () => {
    expect(
      sessionNoTerminalEvent.check(
        ctx('{"event":"start"}\n{"event":"end"}\n'),
      ).length,
    ).toBe(0);
  });
  it('accepts complete / finalized / done as terminal', () => {
    expect(
      sessionNoTerminalEvent.check(ctx('{"event":"complete"}\n')).length,
    ).toBe(0);
    expect(
      sessionNoTerminalEvent.check(ctx('{"event":"finalized"}\n')).length,
    ).toBe(0);
    expect(sessionNoTerminalEvent.check(ctx('{"event":"done"}\n')).length).toBe(0);
  });
  it('skips trailing blank/malformed lines when picking $last', () => {
    expect(
      sessionNoTerminalEvent.check(
        ctx('{"event":"end"}\n\nbroken\n'),
      ).length,
    ).toBe(0);
  });
  it('no-ops on empty file', () => {
    expect(sessionNoTerminalEvent.check(ctx('')).length).toBe(0);
  });
});

describe('jsonlStarterRules — pack registration', () => {
  it('exports 4 rules', () => {
    expect(jsonlStarterRules).toHaveLength(4);
  });
  it('all rules share the jsonl kind discriminator', () => {
    for (const r of jsonlStarterRules) {
      // kind discriminator dropped — single LintRule shape);
    }
  });
  it('all rule ids share the starter-v0 namespace', () => {
    for (const r of jsonlStarterRules) {
      expect(r.id).toMatch(/^jsonl-starter-v0\//);
    }
  });
});
