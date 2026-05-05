/**
 * Wave 10 — JSONL starter rule pack adversarial scenarios.
 *
 * Same shape as wave-09 but for jsonl rules. Hostile / parser-edge
 * inputs, determinism, non-mutation, finding shape, glob-matching,
 * multi-file batch.
 */
import { parseJsonl } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  jsonlStarterRules,
  sessionEmptyLog,
  sessionMalformedLine,
  sessionMissingEventKey,
  sessionNoTerminalEvent,
} from '../../src/extensions/oclint-rules-jsonl-starter/index.js';
import { runLint } from '../../src/oc-lint/runner.js';

const ALL = [
  sessionEmptyLog,
  sessionMissingEventKey,
  sessionMalformedLine,
  sessionNoTerminalEvent,
] as const;

function ctx(raw: string, fileName = 'session.jsonl') {
  return { fileName, ast: parseJsonl(raw).ast };
}

describe('wave-10 jsonl rules adversarial — hostile inputs', () => {
  const inputs = [
    '',
    '\n',
    '\n\n\n',
    '   \n',
    'broken\n',
    '{"event":"start"}\n',
    '{"event":"start"}\n\n{"event":"end"}\n',
    'broken\nbroken\nbroken\n',
    '{"event":"start"}\nbroken\n{"event":"end"}\n',
    '{}\n', // object but no event key
    '"string line"\n',
    '[1,2,3]\n',
    '42\n',
    'null\n',
    'true\n',
  ];

  for (const rule of ALL) {
    for (const raw of inputs) {
      it(`${rule.id} does not throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => rule.check(ctx(raw))).not.toThrow();
      });
    }
  }
});

describe('wave-10 jsonl rules — determinism', () => {
  for (const rule of ALL) {
    it(`${rule.id} returns identical findings on identical input`, () => {
      const raw = '{"event":"start"}\nbroken\n{"event":"end"}\n';
      const a = rule.check(ctx(raw));
      const b = rule.check(ctx(raw));
      expect(a).toEqual(b);
    });
  }
});

describe('wave-10 jsonl rules — non-mutating', () => {
  it('rules do not mutate the AST across calls', () => {
    const ast = parseJsonl('{"event":"a"}\nbroken\n{"event":"b"}\n').ast;
    const before = JSON.stringify(ast);
    for (const rule of ALL) {
      rule.check({ fileName: 'session.jsonl', ast });
    }
    expect(JSON.stringify(ast)).toBe(before);
  });
});

describe('wave-10 jsonl — empty-log thoroughness', () => {
  it('flags entirely empty file', () => {
    expect(sessionEmptyLog.check(ctx('')).length).toBe(1);
  });
  it('flags blank-only file', () => {
    expect(sessionEmptyLog.check(ctx('\n\n')).length).toBe(1);
  });
  it('flags file with only malformed lines', () => {
    expect(sessionEmptyLog.check(ctx('a\nb\n')).length).toBe(1);
  });
  it('passes file with one value line', () => {
    expect(sessionEmptyLog.check(ctx('{"a":1}\n')).length).toBe(0);
  });
});

describe('wave-10 jsonl — missing-event-key thoroughness', () => {
  it('flags object lines without event key', () => {
    expect(
      sessionMissingEventKey.check(ctx('{"a":1}\n{"b":2}\n')).length,
    ).toBe(2);
  });
  it('flags non-object value lines', () => {
    expect(sessionMissingEventKey.check(ctx('"foo"\n[1,2]\n42\n')).length).toBe(3);
  });
  it('passes when every value line has event', () => {
    expect(
      sessionMissingEventKey.check(
        ctx('{"event":"a"}\n{"event":"b","extra":1}\n'),
      ).length,
    ).toBe(0);
  });
});

describe('wave-10 jsonl — malformed-line thoroughness', () => {
  it('flags every malformed line individually', () => {
    expect(
      sessionMalformedLine.check(ctx('a\nb\nc\nd\ne\n')).length,
    ).toBe(5);
  });
  it('skips blank and value lines', () => {
    expect(
      sessionMalformedLine.check(ctx('{"a":1}\n\n{"b":2}\n')).length,
    ).toBe(0);
  });
  it('mixed lines: only malformed counted', () => {
    const findings = sessionMalformedLine.check(
      ctx('{"a":1}\nbroken1\n\nbroken2\n{"b":2}\n'),
    );
    expect(findings.length).toBe(2);
  });
});

describe('wave-10 jsonl — no-terminal-event thoroughness', () => {
  const terminals = ['end', 'complete', 'finalized', 'done'];
  for (const term of terminals) {
    it(`accepts ${term} as terminal`, () => {
      expect(
        sessionNoTerminalEvent.check(ctx(`{"event":"${term}"}\n`)).length,
      ).toBe(0);
    });
  }
  it('flags last event = step', () => {
    expect(
      sessionNoTerminalEvent.check(ctx('{"event":"step"}\n')).length,
    ).toBe(1);
  });
  it('skips trailing blanks/malformed when picking $last', () => {
    expect(
      sessionNoTerminalEvent.check(
        ctx('{"event":"end"}\n\nbroken\n'),
      ).length,
    ).toBe(0);
  });
  it('no-ops on empty file', () => {
    expect(sessionNoTerminalEvent.check(ctx('')).length).toBe(0);
  });
  it('no-ops when last value line is non-object', () => {
    expect(sessionNoTerminalEvent.check(ctx('"just-a-string"\n')).length).toBe(0);
  });
});

describe('wave-10 jsonl — runner glob-matching', () => {
  it('*.jsonl matches session.jsonl but not gateway.jsonc', () => {
    const result = runLint({
      rules: [...jsonlStarterRules],
      files: [{ name: 'session.jsonl', ast: parseJsonl('').ast }],
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.fileName === 'session.jsonl')).toBe(true);
  });

  it('does not match files with non-matching extension', () => {
    const result = runLint({
      rules: [...jsonlStarterRules],
      files: [{ name: 'session.txt', ast: parseJsonl('').ast }],
    });
    expect(result.diagnostics.length).toBe(0);
  });
});

describe('wave-10 jsonl — multi-file batch', () => {
  it('reports per-file findings without cross-contamination', () => {
    const result = runLint({
      rules: [...jsonlStarterRules],
      // Use filenames that match the tightened session globs
      // (`{session,audit,events}*.jsonl`) — unrelated `.jsonl` files
      // are now correctly skipped.
      files: [
        { name: 'session-a.jsonl', ast: parseJsonl('').ast },
        { name: 'session-b.jsonl', ast: parseJsonl('{"event":"step"}\n').ast },
      ],
    });
    const aFindings = result.diagnostics.filter((d) => d.fileName === 'session-a.jsonl');
    const bFindings = result.diagnostics.filter((d) => d.fileName === 'session-b.jsonl');
    expect(aFindings.length).toBeGreaterThan(0);
    expect(bFindings.length).toBeGreaterThan(0);
    for (const d of aFindings) expect(d.fileName).toBe('session-a.jsonl');
    for (const d of bFindings) expect(d.fileName).toBe('session-b.jsonl');
  });
});

describe('wave-10 jsonl — pack invariants', () => {
  it('exports 4 rules', () => {
    expect(jsonlStarterRules).toHaveLength(4);
  });
  it('all rules use jsonl-starter-v0 namespace (shared discriminator dropped)', () => {
    for (const r of jsonlStarterRules) {
      expect(r.id.startsWith('jsonl-starter-v0/')).toBe(true);
    }
  });
  it('rule ids are unique', () => {
    const ids = jsonlStarterRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('rule ids share namespace', () => {
    for (const r of jsonlStarterRules) {
      expect(r.id.startsWith('jsonl-starter-v0/')).toBe(true);
    }
  });
});

describe('wave-10 jsonl — large session simulation', () => {
  it('handles a 5000-line session log', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(JSON.stringify({ event: 'step', n: i }));
    }
    const raw = lines.join('\n') + '\n{"event":"end"}\n';
    const ast = parseJsonl(raw).ast;
    for (const rule of ALL) {
      expect(() => rule.check({ fileName: 'big.jsonl', ast })).not.toThrow();
    }
  });
});
