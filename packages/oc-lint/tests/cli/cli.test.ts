/**
 * openclaw-pinch CLI smoke tests — verify the runCli dispatcher works for
 * each subcommand and produces the expected JSON shape on pipe.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';

interface CapturedOutput {
  stdoutLines: string[];
  stderrLines: string[];
  exitCode: number;
}

async function runCliCapture(argv: string[]): Promise<CapturedOutput> {
  // Force JSON mode for predictable output by injecting --json.
  const argvWithJson = argv.includes('--json') || argv.includes('--human')
    ? argv
    : [...argv, '--json'];
  const stdoutLines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // Vitest leaves stdout.isTTY false anyway, but force JSON via flag.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    stdoutLines.push(String(chunk).replace(/\n$/, ''));
    return true;
  }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runCli(argvWithJson);
  } finally {
    process.stdout.write = origWrite;
  }
  return { stdoutLines, stderrLines: [], exitCode };
}

function makeFixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinch-cli-'));
  // AGENTS.md without `## Boundaries` triggers
  // `starter-v0/agents/missing-boundaries`.
  writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
  return dir;
}

describe('openclaw-pinch CLI', () => {
  it('CLI-01 help prints usage', async () => {
    const r = await runCliCapture(['help']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.stdoutLines[0]!);
    expect(json.bin).toBe('openclaw-pinch');
    expect(json.subcommands).toContain('run');
    expect(json.subcommands).toContain('lint');
    expect(json.subcommands).toContain('list-rules');
  });

  it('CLI-02 list-rules emits the starter pack', async () => {
    const r = await runCliCapture(['list-rules']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.stdoutLines[0]!);
    expect(json.pack).toBe('starter-v0');
    expect(json.count).toBeGreaterThan(0);
    expect(Array.isArray(json.rules)).toBe(true);
    const ids = json.rules.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.startsWith('starter-v0/'))).toBe(true);
  });

  it('CLI-03 run on a workspace with no findings exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-clean-'));
    writeFileSync(
      join(dir, 'AGENTS.md'),
      '## Tools\n- gh\n## Boundaries\n- never rm -rf\n',
      'utf-8',
    );
    const r = await runCliCapture(['run', dir]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.stdoutLines[0]!);
    expect(json.ok).toBe(true);
  });

  it('CLI-04 run surfaces findings with severity-min default 0', async () => {
    const dir = makeFixtureWorkspace();
    const r = await runCliCapture(['run', dir]);
    const json = JSON.parse(r.stdoutLines[0]!);
    // starter-v0/agents/missing-boundaries fires at info severity by
    // default; severity-min default of 0 includes info, so it shows.
    expect(json.diagnostics.length).toBeGreaterThan(0);
    const boundaries = (json.diagnostics as Array<{ ruleId: string }>).find(
      (d) => d.ruleId === 'starter-v0/agents/missing-boundaries',
    );
    expect(boundaries).toBeDefined();
  });

  it('CLI-05 --severity-min warning filters out info-only findings', async () => {
    const dir = makeFixtureWorkspace();
    const r = await runCliCapture(['run', dir, '--severity-min', 'warning']);
    expect(r.exitCode).toBe(0); // info findings filtered, no warnings
    const json = JSON.parse(r.stdoutLines[0]!);
    expect(json.diagnostics).toEqual([]);
  });

  it('CLI-06 lint <file> targets specific files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-direct-'));
    const f = join(dir, 'AGENTS.md');
    writeFileSync(f, '## Tools\n', 'utf-8');
    const r = await runCliCapture(['lint', f]);
    const json = JSON.parse(r.stdoutLines[0]!);
    expect(json.filesLinted).toBe(1);
  });

  it('CLI-07 lint with no files exits 2', async () => {
    const r = await runCliCapture(['lint']);
    expect(r.exitCode).toBe(2);
  });

  it('CLI-08 unknown subcommand exits 2', async () => {
    const r = await runCliCapture(['no-such-cmd']);
    expect(r.exitCode).toBe(2);
  });

  it('CLI-09 --skip <id> disables a rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-skip-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
    // Without --skip: missing-boundaries finding fires.
    const baseline = await runCliCapture(['run', dir]);
    const baselineJson = JSON.parse(baseline.stdoutLines[0]!);
    expect(
      baselineJson.diagnostics.some(
        (d: { ruleId: string }) =>
          d.ruleId === 'starter-v0/agents/missing-boundaries',
      ),
    ).toBe(true);
    // With --skip: it's gone.
    const skipped = await runCliCapture([
      'run',
      dir,
      '--skip',
      'starter-v0/agents/missing-boundaries',
    ]);
    const skippedJson = JSON.parse(skipped.stdoutLines[0]!);
    expect(
      skippedJson.diagnostics.some(
        (d: { ruleId: string }) =>
          d.ruleId === 'starter-v0/agents/missing-boundaries',
      ),
    ).toBe(false);
  });

  it('CLI-10 --severity <id>=<level> overrides severity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-sev-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
    // Bump missing-boundaries from info → error; exit code becomes 1.
    const r = await runCliCapture([
      'run',
      dir,
      '--severity',
      'starter-v0/agents/missing-boundaries=error',
    ]);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.stdoutLines[0]!);
    const fired = json.diagnostics.find(
      (d: { ruleId: string; severity: string }) =>
        d.ruleId === 'starter-v0/agents/missing-boundaries',
    );
    expect(fired?.severity).toBe('error');
  });

  it('CLI-11 --only <pattern> allowlists by rule-id glob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-only-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n', 'utf-8');
    // Allowlist only the agents-missing rules; nothing
    // else can fire even if it would have.
    const r = await runCliCapture([
      'run',
      dir,
      '--only',
      'starter-v0/agents/missing-*',
    ]);
    expect(r.exitCode).toBe(0); // info-only
    const json = JSON.parse(r.stdoutLines[0]!);
    for (const d of json.diagnostics as Array<{ ruleId: string }>) {
      expect(d.ruleId.startsWith('starter-v0/agents/missing-')).toBe(true);
    }
  });

  it('CLI-12 multiple --skip flags are cumulative', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-multi-skip-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n', 'utf-8');
    const r = await runCliCapture([
      'run',
      dir,
      '--skip',
      'starter-v0/agents/missing-boundaries',
      '--skip',
      'starter-v0/agents/empty-tools-section',
    ]);
    const json = JSON.parse(r.stdoutLines[0]!);
    const ids = (json.diagnostics as Array<{ ruleId: string }>).map(
      (d) => d.ruleId,
    );
    expect(ids).not.toContain('starter-v0/agents/missing-boundaries');
    expect(ids).not.toContain('starter-v0/agents/empty-tools-section');
  });

  it('CLI-13 workspace.json `lint.skip` disables a rule durably', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-skip-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({
        lint: { skip: ['starter-v0/agents/missing-boundaries'] },
      }),
      'utf-8',
    );
    const r = await runCliCapture(['run', dir]);
    const json = JSON.parse(r.stdoutLines[0]!);
    const ids = (json.diagnostics as Array<{ ruleId: string }>).map(
      (d) => d.ruleId,
    );
    expect(ids).not.toContain('starter-v0/agents/missing-boundaries');
  });

  it('CLI-14 workspace.json `lint.skip` glob disables a whole namespace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-glob-skip-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n', 'utf-8');
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({ lint: { skip: ['starter-v0/agents/*'] } }),
      'utf-8',
    );
    const r = await runCliCapture(['run', dir]);
    const json = JSON.parse(r.stdoutLines[0]!);
    const ids = (json.diagnostics as Array<{ ruleId: string }>).map(
      (d) => d.ruleId,
    );
    // Every starter-v0/agents/* rule is disabled — no diagnostic id
    // should match that prefix.
    expect(ids.every((id) => !id.startsWith('starter-v0/agents/'))).toBe(true);
  });

  it('CLI-15 workspace.json `lint.severity` overrides default severity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-sev-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({
        lint: {
          severity: { 'starter-v0/agents/missing-boundaries': 'error' },
        },
      }),
      'utf-8',
    );
    const r = await runCliCapture(['run', dir]);
    expect(r.exitCode).toBe(1); // error severity → exit 1
    const json = JSON.parse(r.stdoutLines[0]!);
    const fired = (
      json.diagnostics as Array<{ ruleId: string; severity: string }>
    ).find((d) => d.ruleId === 'starter-v0/agents/missing-boundaries');
    expect(fired?.severity).toBe('error');
  });

  it('CLI-16 workspace.json `lint.only` allowlist limits which rules run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-only-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n', 'utf-8');
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({ lint: { only: ['starter-v0/agents/missing-*'] } }),
      'utf-8',
    );
    const r = await runCliCapture(['run', dir]);
    const json = JSON.parse(r.stdoutLines[0]!);
    const ids = (json.diagnostics as Array<{ ruleId: string }>).map(
      (d) => d.ruleId,
    );
    for (const id of ids) {
      expect(id.startsWith('starter-v0/agents/missing-')).toBe(true);
    }
  });

  it('CLI-17 CLI --skip wins over workspace.json severity (precedence)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-precedence-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({
        lint: {
          severity: { 'starter-v0/agents/missing-boundaries': 'error' },
        },
      }),
      'utf-8',
    );
    // CLI --skip removes the rule entirely; severity override is moot.
    const r = await runCliCapture([
      'run',
      dir,
      '--skip',
      'starter-v0/agents/missing-boundaries',
    ]);
    expect(r.exitCode).toBe(0); // rule skipped → no error → 0
    const json = JSON.parse(r.stdoutLines[0]!);
    const ids = (json.diagnostics as Array<{ ruleId: string }>).map(
      (d) => d.ruleId,
    );
    expect(ids).not.toContain('starter-v0/agents/missing-boundaries');
  });

  it('CLI-18 missing workspace.json is not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinch-ws-missing-'));
    writeFileSync(join(dir, 'AGENTS.md'), '## Tools\n', 'utf-8');
    // No workspace.json at all — should still work.
    const r = await runCliCapture(['run', dir]);
    expect(r.exitCode).toBe(0);
  });
});
