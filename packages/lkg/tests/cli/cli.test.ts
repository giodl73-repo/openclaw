/**
 * openclaw-cage CLI smoke tests — exercise status / observe /
 * list-trackers / fingerprint / help end-to-end against a real
 * temp-directory workspace.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';

interface Captured {
  out: string[];
  err: string[];
  exitCode: number;
}

async function captureCli(argv: string[]): Promise<Captured> {
  // Force JSON for predictable output by injecting --json when no
  // explicit format flag is present.
  const argvJson = argv.includes('--json') || argv.includes('--human')
    ? argv
    : [...argv, '--json'];
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((c: any) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((c: any) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  let exitCode = -1;
  try {
    exitCode = await runCli(argvJson);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out, err, exitCode };
}

function makeFixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-lkg-cli-'));
  writeFileSync(
    join(dir, 'AGENTS.md'),
    '## Tools\n- gh\n## Boundaries\n- never rm -rf\n',
    'utf-8',
  );
  writeFileSync(join(dir, 'TOOLS.md'), '## Tools\n### t # R1, READ\n', 'utf-8');
  return dir;
}

describe('openclaw-cage CLI', () => {
  it('CLI-LKG-01 help exits 0 with subcommand list', async () => {
    const r = await captureCli(['help']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.bin).toBe('openclaw-cage');
    expect(json.subcommands).toContain('status');
    expect(json.subcommands).toContain('observe');
    expect(json.subcommands).toContain('list-trackers');
    expect(json.subcommands).toContain('fingerprint');
  });

  it('CLI-LKG-02 list-trackers reports walked + tracked counts', async () => {
    const dir = makeFixtureWorkspace();
    const r = await captureCli(['list-trackers', dir]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.workspaceDir).toBe(dir);
    expect(json.walkedFiles).toBeGreaterThan(0);
    expect(Array.isArray(json.entries)).toBe(true);
  });

  it('CLI-LKG-03 status walks the workspace and observes each tracked file', async () => {
    const dir = makeFixtureWorkspace();
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.tracked).toBeGreaterThan(0);
    expect(Array.isArray(json.observations)).toBe(true);
    // Every observation has an outcome field.
    for (const o of json.observations) {
      expect(['valid', 'promoted', 'recovered', 'skipped', 'failed']).toContain(o.outcome);
    }
  });

  it('CLI-LKG-04 fingerprint returns sha256 hex over file bytes', async () => {
    const dir = makeFixtureWorkspace();
    const file = join(dir, 'AGENTS.md');
    const r = await captureCli(['fingerprint', file]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.file).toBe(file);
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.bytes).toBeGreaterThan(0);
  });

  it('CLI-LKG-05 fingerprint without <file> exits 2', async () => {
    const r = await captureCli(['fingerprint']);
    expect(r.exitCode).toBe(2);
    const errText = r.err.join('');
    expect(errText).toMatch(/required/);
  });

  it('CLI-LKG-06 observe without <file> exits 2', async () => {
    const r = await captureCli(['observe']);
    expect(r.exitCode).toBe(2);
  });

  it('CLI-LKG-07 observe of a file outside workspace exits 2', async () => {
    const dir = makeFixtureWorkspace();
    const stranger = mkdtempSync(join(tmpdir(), 'oc-lkg-stranger-'));
    writeFileSync(join(stranger, 'AGENTS.md'), '# x\n', 'utf-8');
    const r = await captureCli([
      'observe',
      join(stranger, 'AGENTS.md'),
      '--root',
      dir,
    ]);
    expect(r.exitCode).toBe(2);
    const errText = r.err.join('');
    expect(errText).toMatch(/not a canonical openclaw artifact/);
  });

  it('CLI-LKG-08 observe of a tracked file returns LKGObservation', async () => {
    const dir = makeFixtureWorkspace();
    const file = join(dir, 'AGENTS.md');
    const r = await captureCli(['observe', file, '--root', dir]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(['valid', 'promoted', 'recovered', 'skipped', 'failed']).toContain(json.outcome);
    expect(json.role).toBeDefined();
  });

  it('CLI-LKG-09 unknown subcommand exits 2', async () => {
    const r = await captureCli(['no-such-cmd']);
    expect(r.exitCode).toBe(2);
  });

  it('CLI-LKG-10 empty argv prints help, exits 0', async () => {
    const r = await captureCli([]);
    expect(r.exitCode).toBe(0);
  });

  it('CLI-LKG-12 status honors workspace.json `lkg.skip` (skip by role id)', async () => {
    const dir = makeFixtureWorkspace();
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({ lkg: { skip: ['agents.md'] } }),
      'utf-8',
    );
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.skippedByConfig).toBeGreaterThan(0);
    const skippedRoles = (json.skipped as Array<{ role: string }>).map((s) => s.role);
    expect(skippedRoles).toContain('agents.md');
    // The observed list should NOT include agents.md.
    const observedRoles = (json.observations as Array<{ role: string }>).map((o) => o.role);
    expect(observedRoles).not.toContain('agents.md');
  });

  it('CLI-LKG-13 status honors --skip CLI flag (combined with workspace.json)', async () => {
    const dir = makeFixtureWorkspace();
    writeFileSync(
      join(dir, 'workspace.json'),
      JSON.stringify({ lkg: { skip: ['agents.md'] } }),
      'utf-8',
    );
    const r = await captureCli(['status', dir, '--skip', 'tools.md']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    const skippedRoles = (json.skipped as Array<{ role: string }>).map((s) => s.role);
    // Both the workspace.json skip AND the CLI --skip apply.
    expect(skippedRoles).toContain('agents.md');
    expect(skippedRoles).toContain('tools.md');
  });

  it('CLI-LKG-14 --skip with `*` is treated as a path glob', async () => {
    const dir = makeFixtureWorkspace();
    // Skip everything by glob — observations array should be empty.
    const r = await captureCli(['status', dir, '--skip', '*.md']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.observed).toBe(0);
    expect(json.skippedByConfig).toBeGreaterThan(0);
  });

  it('CLI-LKG-15 status detects orphan tracker (file deleted since promote)', async () => {
    const { mkdtempSync, rmSync, writeFileSync: wsync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'oc-lkg-orphan-'));
    wsync(join(dir, 'AGENTS.md'), '## Tools\n- gh\n## Boundaries\n- never rm -rf\n', 'utf-8');
    wsync(join(dir, 'gateway.jsonc'), '{ "version": "0.1.0" }\n', 'utf-8');
    // First, promote — captures both files into LKG.
    const promoteR = await captureCli(['promote', dir]);
    expect(promoteR.exitCode).toBe(0);
    // Delete gateway.jsonc — it's now an orphan.
    rmSync(join(dir, 'gateway.jsonc'));
    // Status should detect the orphan.
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(1); // ok=false because of orphan
    const json = JSON.parse(r.out.join(''));
    expect(json.orphanCount).toBe(1);
    expect(json.orphans[0].relPath).toMatch(/gateway\.jsonc$/);
    expect(json.orphans[0].lastPromotedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.byOutcome.orphan).toBe(1);
    expect(json.ok).toBe(false);
  });

  it('CLI-LKG-12 status surfaces LKG_STATE_FILE_CORRUPT on malformed state file', async () => {
    const dir = makeFixtureWorkspace();
    mkdirSync(join(dir, '.openclaw'));
    writeFileSync(join(dir, '.openclaw', 'lkg-health.json'), '{ this is not valid', 'utf-8');
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(2);
    const errBody = JSON.parse(r.err.join(''));
    expect(errBody.error.code).toBe('LKG_STATE_FILE_CORRUPT');
    expect(errBody.error.message).toMatch(/parse failed/);
  });

  it('CLI-LKG-13 status surfaces LKG_STATE_FILE_VERSION_MISMATCH on future-version state', async () => {
    const dir = makeFixtureWorkspace();
    mkdirSync(join(dir, '.openclaw'));
    writeFileSync(
      join(dir, '.openclaw', 'lkg-health.json'),
      JSON.stringify({ version: '9.9.9', entries: {} }),
      'utf-8',
    );
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(2);
    const errBody = JSON.parse(r.err.join(''));
    expect(errBody.error.code).toBe('LKG_STATE_FILE_VERSION_MISMATCH');
    expect(errBody.error.message).toMatch(/9\.9\.9/);
  });

  it('CLI-LKG-14 status surfaces WORKSPACE_CONFIG_PARSE_FAILED on malformed workspace.json', async () => {
    const dir = makeFixtureWorkspace();
    writeFileSync(join(dir, 'workspace.json'), '{ this is not valid', 'utf-8');
    const r = await captureCli(['status', dir]);
    expect(r.exitCode).toBe(2);
    const errBody = JSON.parse(r.err.join(''));
    expect(errBody.error.code).toBe('WORKSPACE_CONFIG_PARSE_FAILED');
  });

  it('CLI-LKG-11 closed-pipe writes (sync EPIPE) exit gracefully', async () => {
    const orig = process.stdout.write.bind(process.stdout);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((_chunk: any) => {
      calls++;
      const err = new Error('write EPIPE') as NodeJS.ErrnoException;
      err.code = 'EPIPE';
      throw err;
    }) as typeof process.stdout.write;
    let exitCode = -99;
    try {
      exitCode = await runCli(['help', '--json']);
    } finally {
      process.stdout.write = orig;
    }
    expect(calls).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  });
});
