/**
 * openclaw-policy CLI smoke tests — exercise generate / check /
 * diff / evaluate / list-generators / help end-to-end.
 *
 * Each test uses a fixture workspace + temporary IR file path so
 * the full pipeline (manifest walk → parse → extract → buildPolicyIR
 * → emit) runs against real bytes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'oc-policy-cli-'));
  writeFileSync(
    join(dir, 'SOUL.md'),
    '## Boundaries\n- Never share RESTRICTED data\n- Never bypass approval\n',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'TOOLS.md'),
    '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n',
    'utf-8',
  );
  return dir;
}

describe('openclaw-policy CLI', () => {
  it('CLI-01 help exits 0 with subcommand list', async () => {
    const r = await captureCli(['help']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.bin).toBe('openclaw-policy');
    expect(json.subcommands).toContain('generate');
    expect(json.subcommands).toContain('check');
    expect(json.subcommands).toContain('evaluate');
  });

  it('CLI-02 list-generators shows registered md generator', async () => {
    const r = await captureCli(['list-generators']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.count).toBeGreaterThan(0);
    expect(json.generators.find((g: { id: string }) => g.id === 'md')).toBeDefined();
  });

  it('CLI-03 generate produces a PolicyIR with stable policyId', async () => {
    const ws = makeFixtureWorkspace();
    const r = await captureCli(['generate', ws]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.generator).toBe('md');
    expect(json.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(json.tools).toBe(2); // post-channel + read-doc
    expect(json.denyRules).toBe(2);
  });

  it('CLI-04 generate --out writes IR to disk', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    const r = await captureCli(['generate', ws, '--out', outPath]);
    expect(r.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(written.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(written.tools).toHaveLength(2);
  });

  it('CLI-05 check on a valid IR exits 0', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    await captureCli(['generate', ws, '--out', outPath]);
    const r = await captureCli(['check', outPath]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
  });

  it('CLI-06 check on a tampered IR exits 1', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    await captureCli(['generate', ws, '--out', outPath]);
    // Tamper: mutate the body without recomputing policyId.
    const ir = JSON.parse(readFileSync(outPath, 'utf-8'));
    ir.tools.push({ id: 'sneaky', capabilities: [], risk: 'low', sensitivity: 'public' });
    writeFileSync(outPath, JSON.stringify(ir, null, 2), 'utf-8');
    const r = await captureCli(['check', outPath]);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(false);
    expect(json.tampered).toBe(true);
  });

  it('CLI-07 evaluate returns Decision for known tool', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    await captureCli(['generate', ws, '--out', outPath]);
    const r = await captureCli(['evaluate', outPath, 'post-channel']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.decision.kind).toBe('requires-approval'); // R5 + IRREVERSIBLE_EXTERNAL
  });

  it('CLI-08 evaluate returns deny for unknown tool', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    await captureCli(['generate', ws, '--out', outPath]);
    const r = await captureCli(['evaluate', outPath, 'mystery']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.decision.kind).toBe('deny');
    expect(json.decision.reason).toContain('unknown-tool');
  });

  it('CLI-09 evaluate honors --args for tag-based deny matching', async () => {
    const ws = makeFixtureWorkspace();
    const outPath = join(ws, 'policy-ir.json');
    await captureCli(['generate', ws, '--out', outPath]);
    // The deny tag derived from "Never share RESTRICTED data" is
    // `*never*share*restricted*` — every keyword must appear in
    // the value (case-insensitive) for the tag to match. Construct
    // an arg that contains all three keywords so the deny fires.
    const r = await captureCli([
      'evaluate',
      outPath,
      'read-doc',
      '--args',
      '{"action":"never share these RESTRICTED documents"}',
    ]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.decision.kind).toBe('deny');
  });

  it('CLI-10 diff between two IRs reports changes', async () => {
    const ws = makeFixtureWorkspace();
    const aPath = join(ws, 'a.json');
    const bPath = join(ws, 'b.json');
    await captureCli(['generate', ws, '--out', aPath]);
    // Modify the workspace, regenerate.
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n### new-tool # R2, READ\n',
      'utf-8',
    );
    await captureCli(['generate', ws, '--out', bPath]);
    const r = await captureCli(['diff', aPath, bPath]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.changed).toBe(true);
    expect(json.tools.added).toContain('new-tool');
  });

  it('CLI-11 unknown subcommand exits 2', async () => {
    const r = await captureCli(['no-such-cmd']);
    expect(r.exitCode).toBe(2);
  });

  it('CLI-12 empty argv prints help, exits 0', async () => {
    const r = await captureCli([]);
    expect(r.exitCode).toBe(0);
  });

  it('CLI-13 check workspace-dir with in-sync policy.jsonc passes integrity AND drift', async () => {
    const ws = makeFixtureWorkspace();
    const policyPath = join(ws, 'policy.jsonc');
    await captureCli(['generate', ws, '--out', policyPath]);
    const r = await captureCli(['check', ws]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.mode).toBe('workspace');
    expect(json.integrity.ok).toBe(true);
    expect(json.drift.checked).toBe(true);
    expect(json.drift.drifted).toBe(false);
  });

  it('CLI-14 check workspace-dir detects drift when sources change', async () => {
    const ws = makeFixtureWorkspace();
    const policyPath = join(ws, 'policy.jsonc');
    await captureCli(['generate', ws, '--out', policyPath]);
    // Add a new tool to TOOLS.md without regenerating policy.jsonc.
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n### added-after # R2, READ\n',
      'utf-8',
    );
    const r = await captureCli(['check', ws]);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(false);
    expect(json.integrity.ok).toBe(true); // bytes on disk are still self-consistent
    expect(json.drift.drifted).toBe(true);
    expect(json.drift.onDiskShape).not.toBe(json.drift.regeneratedShape);
  });

  it('CLI-15 check --no-drift skips regeneration', async () => {
    const ws = makeFixtureWorkspace();
    const policyPath = join(ws, 'policy.jsonc');
    await captureCli(['generate', ws, '--out', policyPath]);
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R1, READ\n### would-be-drift # R2, READ\n',
      'utf-8',
    );
    const r = await captureCli(['check', ws, '--no-drift']);
    expect(r.exitCode).toBe(0); // integrity passes, drift skipped
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.drift.checked).toBe(false);
  });

  it('CLI-16 check workspace-dir with tampered policy fails integrity', async () => {
    const ws = makeFixtureWorkspace();
    const policyPath = join(ws, 'policy.jsonc');
    await captureCli(['generate', ws, '--out', policyPath]);
    const ir = JSON.parse(readFileSync(policyPath, 'utf-8'));
    ir.tools.push({ id: 'sneaky', capabilities: [], risk: 'low', sensitivity: 'public' });
    writeFileSync(policyPath, JSON.stringify(ir, null, 2), 'utf-8');
    const r = await captureCli(['check', ws]);
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.out.join(''));
    expect(json.integrity.ok).toBe(false);
    expect(json.integrity.tampered).toBe(true);
  });

  it('CLI-17 check --policy <path> overrides default policy.jsonc location', async () => {
    const ws = makeFixtureWorkspace();
    const customPath = join(ws, 'custom-policy.json');
    await captureCli(['generate', ws, '--out', customPath]);
    // No policy.jsonc at conventional path; --policy points elsewhere.
    const r = await captureCli(['check', ws, '--policy', customPath]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.ok).toBe(true);
    expect(json.policyPath).toBe(customPath);
  });

  it('CLI-18 diff (no --detail) reports modified IDs only', async () => {
    const ws = makeFixtureWorkspace();
    const aPath = join(ws, 'a.json');
    const bPath = join(ws, 'b.json');
    await captureCli(['generate', ws, '--out', aPath]);
    // Modify the read-doc tool's risk by editing TOOLS.md.
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R3, READ\n',
      'utf-8',
    );
    await captureCli(['generate', ws, '--out', bPath]);
    const r = await captureCli(['diff', aPath, bPath]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.changed).toBe(true);
    const modIds = json.tools.modified.map((m: { id: string }) => m.id);
    expect(modIds).toContain('read-doc');
    // Without --detail, the fields array is empty.
    const readDocMod = json.tools.modified.find((m: { id: string }) => m.id === 'read-doc');
    expect(readDocMod.fields).toEqual([]);
  });

  it('CLI-19 diff --detail surfaces per-field changes for modified entries', async () => {
    const ws = makeFixtureWorkspace();
    const aPath = join(ws, 'a.json');
    const bPath = join(ws, 'b.json');
    await captureCli(['generate', ws, '--out', aPath]);
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R3, READ\n',
      'utf-8',
    );
    await captureCli(['generate', ws, '--out', bPath]);
    const r = await captureCli(['diff', aPath, bPath, '--detail']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    const readDocMod = json.tools.modified.find((m: { id: string }) => m.id === 'read-doc');
    expect(readDocMod).toBeDefined();
    expect(readDocMod.fields.length).toBeGreaterThan(0);
    const riskField = readDocMod.fields.find((f: { field: string }) => f.field === 'risk');
    expect(riskField).toBeDefined();
    expect(riskField.before).toBe('low'); // R1
    expect(riskField.after).toBe('medium'); // R3
  });

  it('CLI-20 diff --detail field changes exclude the id field itself', async () => {
    const ws = makeFixtureWorkspace();
    const aPath = join(ws, 'a.json');
    const bPath = join(ws, 'b.json');
    await captureCli(['generate', ws, '--out', aPath]);
    writeFileSync(
      join(ws, 'TOOLS.md'),
      '## Tools\n### post-channel # R5, COMMUNICATE, IRREVERSIBLE_EXTERNAL\n### read-doc # R3, READ\n',
      'utf-8',
    );
    await captureCli(['generate', ws, '--out', bPath]);
    const r = await captureCli(['diff', aPath, bPath, '--detail']);
    const json = JSON.parse(r.out.join(''));
    const readDocMod = json.tools.modified.find((m: { id: string }) => m.id === 'read-doc');
    const idField = readDocMod.fields.find((f: { field: string }) => f.field === 'id');
    expect(idField).toBeUndefined();
  });

  it('CLI-22 generate uses `policy.generator` from workspace.json as default', async () => {
    const ws = makeFixtureWorkspace();
    writeFileSync(
      join(ws, 'workspace.json'),
      JSON.stringify({ policy: { generator: 'md' } }),
      'utf-8',
    );
    // No --generator flag — should pick up `md` from workspace.json
    // (which equals the ultimate fallback, but the test verifies the
    // path is exercised).
    const r = await captureCli(['generate', ws]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.generator).toBe('md');
  });

  it('CLI-23 generate --generator flag wins over workspace.json', async () => {
    const ws = makeFixtureWorkspace();
    writeFileSync(
      join(ws, 'workspace.json'),
      JSON.stringify({ policy: { generator: 'nonexistent-from-config' } }),
      'utf-8',
    );
    // CLI flag overrides; the `nonexistent-from-config` from
    // workspace.json never runs.
    const r = await captureCli(['generate', ws, '--generator', 'md']);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.generator).toBe('md');
  });

  it('CLI-24 missing workspace.json uses the `md` default', async () => {
    const ws = makeFixtureWorkspace();
    // No workspace.json — should still work with default generator.
    const r = await captureCli(['generate', ws]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.out.join(''));
    expect(json.generator).toBe('md');
  });

  it('CLI-21 closed-pipe writes (sync EPIPE) do not throw and exit gracefully', async () => {
    // Replace stdout.write with one that throws EPIPE on first call,
    // simulating `openclaw-policy ... | head -1` after head exits.
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
      // help → safeWrite path; runs through printHelp's stdout.write.
      exitCode = await runCli(['help', '--json']);
    } finally {
      process.stdout.write = orig;
    }
    expect(calls).toBeGreaterThan(0);
    expect(exitCode).toBe(0); // graceful — no throw, return 0
  });
});
