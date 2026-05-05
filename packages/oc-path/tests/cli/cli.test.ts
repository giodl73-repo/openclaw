/**
 * Smoke tests for the openclaw-path CLI.
 *
 * Tests exercise the `runCli(argv)` entry point directly — no child
 * process spawn — so the test runs at unit-test speed AND assertions
 * happen on the typed return code rather than parsed stdout.
 *
 * stdout is captured via a mock `process.stdout.write`; assertions
 * inspect both the return code and the captured bytes.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';

interface Captured {
  stdout: string;
  stderr: string;
}

function captureIO(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: '', stderr: '' };
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((s: any) => {
    captured.stdout += String(s);
    return true;
  }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((s: any) => {
    captured.stderr += String(s);
    return true;
  }) as any;
  return {
    captured,
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

describe('openclaw-path CLI', () => {
  let workspaceDir: string;
  let cleanup: () => void;
  let captured: Captured;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'oc-cli-'));
    const io = captureIO();
    captured = io.captured;
    cleanup = io.restore;
  });
  afterEach(() => {
    cleanup();
  });

  describe('validate', () => {
    it('CLI-V01 accepts a well-formed path with --json', async () => {
      const code = await runCli(['validate', 'oc://AGENTS.md/Tools/-1', '--json']);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.valid).toBe(true);
      expect(out.structure.file).toBe('AGENTS.md');
      expect(out.structure.section).toBe('Tools');
    });

    it('CLI-V02 rejects a malformed path with code 1', async () => {
      const code = await runCli(['validate', 'oc://X/a\x00b', '--json']);
      expect(code).toBe(1);
      const out = JSON.parse(captured.stdout);
      expect(out.valid).toBe(false);
    });

    it('CLI-V03 missing argument returns 2', async () => {
      const code = await runCli(['validate', '--json']);
      expect(code).toBe(2);
      expect(captured.stderr).toContain('missing');
    });
  });

  describe('resolve', () => {
    it('CLI-R01 finds a leaf in jsonc and prints it', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      writeFileSync(filePath, '{ "version": "1.0" }', 'utf-8');
      const code = await runCli([
        'resolve',
        'oc://gateway.jsonc/version',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.resolved).toBe(true);
      expect(out.match.kind).toBe('leaf');
      expect(out.match.valueText).toBe('1.0');
    });

    it('CLI-R02 returns 1 for not-found path', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      writeFileSync(filePath, '{ "version": "1.0" }', 'utf-8');
      const code = await runCli([
        'resolve',
        'oc://gateway.jsonc/missing',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(1);
      const out = JSON.parse(captured.stdout);
      expect(out.resolved).toBe(false);
    });
  });

  describe('set', () => {
    it('CLI-S01 writes new bytes when path resolves and value is coerce-able', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      writeFileSync(filePath, '{ "version": "1.0" }', 'utf-8');
      const code = await runCli([
        'set',
        'oc://gateway.jsonc/version',
        '2.0',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(0);
      const after = readFileSync(filePath, 'utf-8');
      expect(after).toContain('"2.0"');
    });

    it('CLI-S02 --dry-run does not write to disk', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      const before = '{ "version": "1.0" }';
      writeFileSync(filePath, before, 'utf-8');
      const code = await runCli([
        'set',
        'oc://gateway.jsonc/version',
        '2.0',
        '--cwd',
        workspaceDir,
        '--dry-run',
        '--json',
      ]);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.dryRun).toBe(true);
      expect(out.bytes).toContain('"2.0"');
      // File on disk unchanged.
      expect(readFileSync(filePath, 'utf-8')).toBe(before);
    });

    it('CLI-S03 sentinel-bearing value is refused at emit', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      writeFileSync(filePath, '{ "token": "x" }', 'utf-8');
      const code = await runCli([
        'set',
        'oc://gateway.jsonc/token',
        '__OPENCLAW_REDACTED__',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(2);
      expect(captured.stderr).toMatch(/sentinel|REDACTED|OC_EMIT/i);
    });
  });

  describe('find', () => {
    it('CLI-F01 enumerates wildcard matches', async () => {
      const filePath = join(workspaceDir, 'config.jsonc');
      writeFileSync(
        filePath,
        '{ "items": [ { "id": "a" }, { "id": "b" } ] }',
        'utf-8',
      );
      const code = await runCli([
        'find',
        'oc://config.jsonc/items/*/id',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.count).toBe(2);
    });

    it('CLI-F02 returns 1 when zero matches', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      writeFileSync(filePath, '{}', 'utf-8');
      const code = await runCli([
        'find',
        'oc://gateway.jsonc/nope/*',
        '--cwd',
        workspaceDir,
        '--json',
      ]);
      expect(code).toBe(1);
    });
  });

  describe('emit', () => {
    it('CLI-E01 round-trips jsonc bytes verbatim (byte-fidelity proof)', async () => {
      const filePath = join(workspaceDir, 'gateway.jsonc');
      const before = '// keep this comment\n{\n  "v": 1\n}\n';
      writeFileSync(filePath, before, 'utf-8');
      const code = await runCli(['emit', filePath, '--json']);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.kind).toBe('jsonc');
      expect(out.bytes).toBe(before);
    });

    it('CLI-E02 round-trips md verbatim', async () => {
      const filePath = join(workspaceDir, 'AGENTS.md');
      const before = '## Tools\n- gh\n## Boundaries\n- never rm -rf\n';
      writeFileSync(filePath, before, 'utf-8');
      const code = await runCli(['emit', filePath, '--json']);
      expect(code).toBe(0);
      const out = JSON.parse(captured.stdout);
      expect(out.kind).toBe('md');
      expect(out.bytes).toBe(before);
    });
  });

  describe('help + unknown', () => {
    it('CLI-H01 no args prints help with code 0', async () => {
      const code = await runCli([]);
      expect(code).toBe(0);
      expect(captured.stdout).toContain('USAGE');
    });

    it('CLI-H02 unknown subcommand returns 2', async () => {
      const code = await runCli(['frobnicate']);
      expect(code).toBe(2);
      expect(captured.stderr).toContain('unknown subcommand');
    });

    it('CLI-H03 explicit help subcommand prints usage', async () => {
      const code = await runCli(['help']);
      expect(code).toBe(0);
      expect(captured.stdout).toContain('SUBCOMMANDS');
    });
  });
});
