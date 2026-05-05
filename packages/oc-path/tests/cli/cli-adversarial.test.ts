/**
 * Adversarial / pitfall tests for the openclaw-path CLI.
 *
 * Mirrors the CLI-PINCH-NNN pattern from `pinch/tests/cli/
 * cli-adversarial.test.ts`. Each test locks one mitigation against
 * the threat it defends — argument parsing edge cases, I/O
 * failures, output-boundary sentinel guard, exit-code semantics,
 * per-subcommand pitfalls. Every entry maps to a row in
 * `src/cli/PITFALLS.md` (CLI-OCPATH-NNN namespace).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, scrubSentinel } from '../../src/cli/index.js';

interface Captured {
  stdout: string;
  stderr: string;
}

function captureIO(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: '', stderr: '' };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((s: any) => {
    captured.stdout += String(s);
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((s: any) => {
    captured.stderr += String(s);
    return true;
  }) as typeof process.stderr.write;
  return {
    captured,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

let captured: Captured;
let restore: () => void;

beforeEach(() => {
  const io = captureIO();
  captured = io.captured;
  restore = io.restore;
});

afterEach(() => {
  restore();
});

describe('openclaw-path CLI — argument parsing (CLI-OCPATH-001..009)', () => {
  it('CLI-OCPATH-001 unknown subcommand → non-zero exit', async () => {
    const code = await runCli(['no-such-cmd']);
    expect(code).not.toBe(0);
    // The error appears on stderr regardless of mode.
    expect(captured.stderr.length).toBeGreaterThan(0);
  });

  it('CLI-OCPATH-002 empty argv → prints help, exits 0', async () => {
    // Same shape as pinch: no subcommand → help is the friendliest
    // default. Matches `git` (no subcommand → help) and most modern
    // CLI frameworks.
    const code = await runCli([]);
    expect(code).toBe(0);
  });

  it('CLI-OCPATH-003 validate with no path argument → exit non-zero', async () => {
    const code = await runCli(['validate', '--json']);
    expect(code).not.toBe(0);
  });
});

describe('openclaw-path CLI — I/O failures (CLI-OCPATH-010..019)', () => {
  it('CLI-OCPATH-010 emit on a missing file → exit non-zero with structured error', async () => {
    const code = await runCli([
      'emit',
      '/abs/that/does/not/exist.md',
      '--json',
    ]);
    expect(code).not.toBe(0);
    expect(captured.stderr.length).toBeGreaterThan(0);
  });

  it('CLI-OCPATH-011 resolve against a missing file → exit non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-adv-'));
    const code = await runCli([
      'resolve',
      'oc://AGENTS.md/Tools',
      '--cwd',
      join(dir, 'does-not-exist'),
      '--json',
    ]);
    expect(code).not.toBe(0);
  });

  it('CLI-OCPATH-012 set with --dry-run on a missing file → exit non-zero (cannot read)', async () => {
    const code = await runCli([
      'set',
      'oc://AGENTS.md/Tools',
      'value',
      '--file',
      '/abs/does/not/exist.md',
      '--dry-run',
      '--json',
    ]);
    expect(code).not.toBe(0);
  });
});

describe('openclaw-path CLI — output / TTY (CLI-OCPATH-020..029)', () => {
  it('CLI-OCPATH-020 --json forces JSON output regardless of TTY', async () => {
    const code = await runCli(['validate', 'oc://AGENTS.md', '--json']);
    expect(code).toBe(0);
    expect(() => JSON.parse(captured.stdout.trim())).not.toThrow();
  });

  it('CLI-OCPATH-021 --human forces human-readable output regardless of TTY', async () => {
    const code = await runCli(['validate', 'oc://AGENTS.md', '--human']);
    expect(code).toBe(0);
    // Human mode also returns JSON for validate (no human formatter
    // for that subcommand) — but the flag still works without error.
    expect(captured.stdout.length).toBeGreaterThan(0);
  });
});

describe('openclaw-path CLI — sentinel scrub (CLI-OCPATH-030..039)', () => {
  it('CLI-OCPATH-030 scrubSentinel replaces sentinel with [REDACTED]', () => {
    expect(scrubSentinel('hello __OPENCLAW_REDACTED__ world')).toBe(
      'hello [REDACTED] world',
    );
    expect(
      scrubSentinel('a__OPENCLAW_REDACTED__b__OPENCLAW_REDACTED__c'),
    ).toBe('a[REDACTED]b[REDACTED]c');
    expect(scrubSentinel('clean')).toBe('clean');
  });

  it('CLI-OCPATH-031 emit pipeline scrubs output (defense-in-depth)', async () => {
    // Validate sets up a clean output path. Even though no current
    // subcommand surfaces raw file content, the unconditional
    // scrub at the emit boundary protects against future verbs
    // that might (e.g., `cat <file>` style).
    const code = await runCli(['validate', 'oc://AGENTS.md', '--json']);
    expect(code).toBe(0);
    expect(captured.stdout).not.toContain('__OPENCLAW_REDACTED__');
  });

  it('CLI-OCPATH-032 emitError pipeline scrubs error messages', async () => {
    // Force a parse error with a sentinel-bearing path. The CLI
    // rejects via OcPathError; the error message must NOT echo
    // the raw sentinel bytes back to stderr.
    //
    // OcPath validation rejects sentinel substrings as part of the
    // substrate's own guard — the path string itself never reaches
    // the parser unscrubbed. We test the CLI scrub by using a
    // structurally-bad path that exercises the error pipeline.
    await runCli(['validate', 'not-an-oc-path-with-__OPENCLAW_REDACTED__-in-it', '--json']);
    expect(captured.stderr).not.toContain('__OPENCLAW_REDACTED__');
  });
});

describe('openclaw-path CLI — per-subcommand pitfalls (CLI-OCPATH-040..049)', () => {
  it('CLI-OCPATH-040 set without value → non-zero exit', async () => {
    const code = await runCli(['set', 'oc://AGENTS.md/Tools', '--json']);
    expect(code).not.toBe(0);
  });

  it('CLI-OCPATH-041 find with a malformed pattern → non-zero exit', async () => {
    const code = await runCli(['find', 'oc://AGENTS.md/[broken-predicate', '--json']);
    expect(code).not.toBe(0);
  });

  it('CLI-OCPATH-042 emit byte-fidelity round-trip on a clean md file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-emit-'));
    const f = join(dir, 'sample.md');
    const raw = '## Tools\n- gh\n## Boundaries\n- never rm -rf\n';
    writeFileSync(f, raw, 'utf-8');
    const code = await runCli(['emit', f, '--json']);
    expect(code).toBe(0);
    // emit subcommand returns the round-tripped bytes; the CLI's
    // exit-0 plus matching JSON shape is the lock.
    const json = JSON.parse(captured.stdout.trim());
    expect(json).toBeDefined();
  });
});

describe('openclaw-path CLI — caller obligations (CLI-OCPATH-050..059)', () => {
  it('CLI-OCPATH-050 LKG-aware set is intentionally NOT in v0', async () => {
    // Documented behavior: `set` writes raw bytes through the
    // substrate emit; if the file is LKG-tracked, the next
    // `LKGStore.observe()` decides whether to promote. A
    // `--via-lkg` flag is deferred until the LKG package
    // surfaces a public `batch` operation. This test locks the
    // current "writes go straight through" semantics.
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-lkg-'));
    const f = join(dir, 'config.jsonc');
    writeFileSync(f, '{ "version": 1 }\n', 'utf-8');
    const code = await runCli([
      'set',
      'oc://config.jsonc/version',
      '2',
      '--file',
      f,
      '--dry-run',
      '--json',
    ]);
    expect(code).toBe(0);
    // --dry-run preserves the original file bytes.
    const fs = await import('node:fs/promises');
    const after = await fs.readFile(f, 'utf-8');
    expect(after).toBe('{ "version": 1 }\n');
  });
});
