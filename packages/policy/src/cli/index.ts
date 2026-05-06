/**
 * `openclaw-policy` CLI — shell-level access to the policy
 * generator + evaluator. Self-hosters invoke it as a standalone bin
 * (`openclaw-policy ...`) or as `openclaw policy ...` once the
 * umbrella dispatcher (#182) lands.
 *
 * **Subcommands**:
 *
 *   `openclaw-policy generate <workspace-dir> [--generator <id>] [--out <path>]`
 *     Walk the workspace via `buildWorkspaceManifest`, parse each
 *     canonical artifact, dispatch to the registered generator
 *     (default `'md'`), and emit the resulting PolicyIR. Stamps
 *     a deterministic `policyId` via RFC 8785 JCS.
 *
 *   `openclaw-policy check <policy-ir-path>`
 *     Read a PolicyIR from disk, recompute `policyId` over the
 *     body, verify it matches. Exit 0 on match, 1 on mismatch
 *     (tampered IR), 2 on parse / read failure.
 *
 *   `openclaw-policy diff <a.json> <b.json>`
 *     Semantic diff between two PolicyIRs — added/removed/changed
 *     tools and deny rules. Useful for `git diff`-style reviews
 *     during operator-facing policy migrations.
 *
 *   `openclaw-policy evaluate <policy-ir-path> <tool-id> [--args <json>]`
 *     Given a tool call, return the upstream Decision shape
 *     (`allow` / `deny` / `requires-approval` / `params`). Mirrors
 *     what a guardrail's `evaluate(event, ctx)` would compute.
 *
 *   `openclaw-policy list-generators`
 *     Print registered generators with id + description.
 *
 *   `openclaw-policy help`
 *
 * **Output**: TTY-aware. Defaults to human-readable when stdout is
 * a TTY; JSON otherwise. `--json` / `--human` flags override.
 *
 * **Sentinel scrub**: every output goes through `scrubSentinel(...)`.
 * Mirrors the openclaw-path + pinch CLI guards.
 *
 * @module @openclaw/policy/cli
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  REDACTED_SENTINEL,
  buildWorkspaceManifest,
  loadWorkspaceConfig,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
  type OcKind,
  type WorkspaceManifestEntry,
} from '@openclaw/oc-path';
import type { LKGFingerprint } from '@openclaw/lkg';
import {
  POLICY_PATH,
  computePolicyId,
  computePolicyShapeHash,
  evaluateDecision,
  getPolicyGenerator,
  listPolicyGenerators,
  type PolicyExtractFile,
  type PolicyIR,
  type ToolCallInput,
  type WorkspacePolicyConfig,
} from '../plugin-sdk/policy/index.js';

// Importing the starter pack registers the `md` generator.
import '../extensions/policy-from-md-starter/generator.js';
import type { MdGeneratorInput } from '../extensions/policy-from-md-starter/generator.js';

// ── Output mode ─────────────────────────────────────────────────────────

interface OutputContext {
  readonly mode: 'human' | 'json';
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function makeOutput(argv: readonly string[]): OutputContext {
  const json = argv.includes('--json');
  const human = argv.includes('--human');
  const isTty = process.stdout.isTTY === true;
  const mode: 'human' | 'json' = json ? 'json' : human ? 'human' : isTty ? 'human' : 'json';
  return { mode, stdout: process.stdout, stderr: process.stderr };
}

const SCRUB_PLACEHOLDER = '[REDACTED]';
export function scrubSentinel(s: string): string {
  if (!s.includes(REDACTED_SENTINEL)) return s;
  return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}

/**
 * Detect EPIPE on a write that targets a closed downstream (e.g.,
 * `openclaw-policy ... | head -1` after `head` exits). On Windows,
 * Node sometimes surfaces this as `EOF` or `ECONNRESET`; treat all
 * three as the same "downstream closed" signal so the CLI can exit
 * gracefully rather than throwing.
 */
export function isClosedPipeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPIPE' || code === 'EOF' || code === 'ECONNRESET';
}

/**
 * Wrap a stream write in EPIPE-tolerant error handling. Returns
 * `false` if the pipe is closed (caller can short-circuit further
 * writes); returns `true` on success or non-EPIPE errors that
 * propagate up. Sync EPIPE on `stream.write` is rare but possible
 * on Windows; async EPIPE arrives via the stream's `'error'` event
 * and is handled by `installPipeGuard` at dispatcher entry.
 */
function safeWrite(stream: NodeJS.WritableStream, text: string): boolean {
  try {
    stream.write(text);
    return true;
  } catch (err) {
    if (isClosedPipeError(err)) return false;
    throw err;
  }
}

function emit(out: OutputContext, payload: Record<string, unknown>, humanLines: readonly string[]): void {
  if (out.mode === 'json') {
    safeWrite(out.stdout, scrubSentinel(JSON.stringify(payload, null, 2)) + '\n');
  } else {
    for (const line of humanLines) {
      if (!safeWrite(out.stdout, scrubSentinel(line) + '\n')) return;
    }
  }
}

function emitError(out: OutputContext, msg: string, code = 'ERR'): void {
  const scrubbed = scrubSentinel(msg);
  if (out.mode === 'json') {
    safeWrite(out.stderr, JSON.stringify({ error: { code, message: scrubbed } }) + '\n');
  } else {
    safeWrite(out.stderr, `${code}: ${scrubbed}\n`);
  }
}

// ── Manifest → PolicyExtractFile[] ──────────────────────────────────────

function parseForKind(kind: OcKind, raw: string): OcAst {
  switch (kind) {
    case 'md':
      return parseMd(raw).ast;
    case 'jsonc':
      return parseJsonc(raw).ast;
    case 'jsonl':
      return parseJsonl(raw).ast;
    case 'yaml':
      return parseYaml(raw).ast;
  }
}

async function entryToExtractFile(
  entry: WorkspaceManifestEntry,
): Promise<PolicyExtractFile> {
  const raw = await fs.readFile(entry.path, 'utf-8');
  return {
    name: entry.relPath.split('/').pop() ?? entry.relPath,
    path: entry.path,
    relPath: entry.relPath,
    raw,
    ast: parseForKind(entry.role.kind, raw),
  };
}

// ── Subcommand: generate ────────────────────────────────────────────────

async function runCmdGenerate(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const dir = resolvePath(positional[0] ?? process.cwd());
  // CLI flag wins; workspace.json `policy.generator` is the durable
  // default; `'md'` is the ultimate fallback.
  const wsConfig = await loadWorkspaceConfig(dir);
  const policySection = wsConfig?.['policy'] as WorkspacePolicyConfig | undefined;
  const generatorId =
    pickFlag(argv, '--generator') ?? policySection?.generator ?? 'md';
  const outPath = pickFlag(argv, '--out');

  const spec = getPolicyGenerator(generatorId);
  if (spec === null) {
    emitError(out, `unknown generator: ${generatorId}`, 'ERR_UNKNOWN_GENERATOR');
    return 2;
  }

  const manifest = await buildWorkspaceManifest(dir);
  const files = await Promise.all(manifest.entries.map(entryToExtractFile));

  // Build a placeholder LKG fingerprint over the manifest's bytes.
  // Real callers thread an actual LKGFingerprint from the LKG store;
  // the CLI computes a content hash so each `generate` run produces
  // a deterministic anchor without mocking.
  const anchor = await computeWorkspaceAnchor(files);

  // Cast: the registry type-erases TValidated; the md generator
  // expects `MdGeneratorInput { files }`. We construct that shape.
  const input: MdGeneratorInput = { files };
  const ir = await spec.generator.generate(
    input as unknown as Parameters<typeof spec.generator.generate>[0],
    anchor,
  );

  if (outPath !== undefined) {
    await fs.writeFile(resolvePath(outPath), JSON.stringify(ir, null, 2) + '\n', 'utf-8');
  }

  emit(
    out,
    {
      ok: true,
      generator: generatorId,
      workspaceDir: dir,
      filesProcessed: files.length,
      writtenTo: outPath !== undefined ? resolvePath(outPath) : null,
      policyId: ir.policyId,
      tools: ir.tools.length,
      denyRules: ir.denyRules.length,
      // Always include the IR in the payload — callers can pipe
      // through `jq .ir` if they don't want to write to a file.
      ir,
    },
    [
      `openclaw-policy generate (generator=${generatorId})`,
      `  workspace: ${dir}`,
      `  files processed: ${files.length}`,
      `  policyId: ${ir.policyId}`,
      `  tools: ${ir.tools.length}`,
      `  deny rules: ${ir.denyRules.length}`,
      ...(outPath !== undefined ? [`  written to: ${resolvePath(outPath)}`] : []),
    ],
  );
  return 0;
}

async function computeWorkspaceAnchor(
  files: readonly PolicyExtractFile[],
): Promise<LKGFingerprint> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    h.update(f.relPath);
    h.update('\0');
    h.update(f.raw);
    bytes += f.raw.length;
  }
  return {
    hash: h.digest('hex'),
    bytes,
    observedAt: new Date().toISOString(),
  };
}

// ── Subcommand: check ───────────────────────────────────────────────────

/**
 * `check` runs in two modes depending on the positional arg:
 *
 *   - **File mode**: positional is a file → integrity check only
 *     (recompute policyId, verify it matches the claimed value).
 *
 *   - **Workspace mode**: positional is a directory → integrity AND
 *     drift check. Regenerates a PolicyIR from the workspace sources
 *     and compares the SHAPE hash (excludes `generatedAt` /
 *     `generatedFrom`) against the on-disk policy. Drift means the
 *     workspace sources have changed but `policy.jsonc` hasn't been
 *     regenerated — operator must regenerate or accept the drift.
 *
 * Flags:
 *   `--policy <path>`  override default `<workspace>/policy.jsonc`
 *   `--no-drift`       integrity only; skip regeneration
 *   `--generator <id>` generator id for drift comparison (default `md`)
 *
 * Exit codes: 0 ok, 1 integrity OR drift violation, 2 usage / I/O.
 */
async function runCmdCheck(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const target = positional[0];
  if (target === undefined) {
    emitError(out, 'check: <policy-path-or-workspace-dir> required', 'ERR_USAGE');
    return 2;
  }
  const resolved = resolvePath(target);

  // Detect file-vs-workspace mode by stat'ing the positional arg.
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    emitError(out, `stat failed: ${err instanceof Error ? err.message : String(err)}`, 'ERR_IO');
    return 2;
  }

  const skipDrift = argv.includes('--no-drift');

  // Workspace mode: positional is a directory.
  if (stat.isDirectory()) {
    const wsConfig = await loadWorkspaceConfig(resolved);
    const policySection = wsConfig?.['policy'] as WorkspacePolicyConfig | undefined;
    const policyOverride =
      pickFlag(argv, '--policy') ?? policySection?.policyPath;
    const generatorId =
      pickFlag(argv, '--generator') ?? policySection?.generator ?? 'md';
    return await runCheckWorkspace(resolved, {
      policyOverride,
      skipDrift,
      generatorId,
      out,
    });
  }

  // File mode: existing integrity-only path.
  return await runCheckFile(resolved, out);
}

async function runCheckFile(path: string, out: OutputContext): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    emitError(out, `read failed: ${err instanceof Error ? err.message : String(err)}`, 'ERR_IO');
    return 2;
  }
  let ir: PolicyIR;
  try {
    ir = JSON.parse(raw) as PolicyIR;
  } catch (err) {
    emitError(out, `parse failed: ${err instanceof Error ? err.message : String(err)}`, 'ERR_PARSE');
    return 2;
  }
  const { policyId: claimed, ...body } = ir;
  const recomputed = computePolicyId(body);
  const ok = claimed === recomputed;
  emit(
    out,
    {
      ok,
      mode: 'file',
      path,
      claimedPolicyId: claimed,
      recomputedPolicyId: recomputed,
      ...(ok ? {} : { tampered: true }),
    },
    ok
      ? [`openclaw-policy check: ${path}  policyId=${claimed}  ✓`]
      : [
          `openclaw-policy check: ${path}  TAMPERED`,
          `  claimed:    ${claimed}`,
          `  recomputed: ${recomputed}`,
        ],
  );
  return ok ? 0 : 1;
}

interface WorkspaceCheckOptions {
  readonly policyOverride: string | undefined;
  readonly skipDrift: boolean;
  readonly generatorId: string;
  readonly out: OutputContext;
}

async function runCheckWorkspace(
  workspaceDir: string,
  opts: WorkspaceCheckOptions,
): Promise<number> {
  const { out, generatorId, skipDrift, policyOverride } = opts;
  const policyPath = policyOverride !== undefined
    ? resolvePath(policyOverride)
    : resolvePath(workspaceDir, POLICY_PATH);

  // Read on-disk policy.
  let raw: string;
  try {
    raw = await fs.readFile(policyPath, 'utf-8');
  } catch (err) {
    emitError(out, `policy read failed at ${policyPath}: ${err instanceof Error ? err.message : String(err)}`, 'ERR_IO');
    return 2;
  }
  let onDisk: PolicyIR;
  try {
    onDisk = JSON.parse(raw) as PolicyIR;
  } catch (err) {
    emitError(out, `policy parse failed at ${policyPath}: ${err instanceof Error ? err.message : String(err)}`, 'ERR_PARSE');
    return 2;
  }

  // Integrity (always).
  const { policyId: claimedId, ...onDiskBody } = onDisk;
  const recomputedId = computePolicyId(onDiskBody);
  const integrityOk = claimedId === recomputedId;

  // Drift detection (default; skipped with --no-drift).
  let driftReport: {
    drifted: boolean;
    onDiskShape: string;
    regeneratedShape: string;
  } | null = null;

  if (!skipDrift) {
    const spec = getPolicyGenerator(generatorId);
    if (spec === null) {
      emitError(out, `unknown generator: ${generatorId}`, 'ERR_UNKNOWN_GENERATOR');
      return 2;
    }
    const manifest = await buildWorkspaceManifest(workspaceDir);
    const files = await Promise.all(manifest.entries.map(entryToExtractFile));
    const anchor = await computeWorkspaceAnchor(files);
    const input: MdGeneratorInput = { files };
    const regenerated = await spec.generator.generate(
      input as unknown as Parameters<typeof spec.generator.generate>[0],
      anchor,
    );
    const onDiskShape = computePolicyShapeHash(onDisk);
    const regeneratedShape = computePolicyShapeHash(regenerated);
    driftReport = {
      drifted: onDiskShape !== regeneratedShape,
      onDiskShape,
      regeneratedShape,
    };
  }

  const ok = integrityOk && (driftReport === null || !driftReport.drifted);

  const humanLines: string[] = [
    `openclaw-policy check: ${policyPath}`,
    `  integrity: ${integrityOk ? '✓' : 'TAMPERED'}`,
    `    claimed:    ${claimedId}`,
    `    recomputed: ${recomputedId}`,
  ];
  if (driftReport !== null) {
    humanLines.push(
      `  drift:     ${driftReport.drifted ? 'DRIFTED' : '✓'}`,
      `    on-disk shape:     ${driftReport.onDiskShape}`,
      `    regenerated shape: ${driftReport.regeneratedShape}`,
    );
  } else {
    humanLines.push(`  drift:     skipped (--no-drift)`);
  }

  emit(
    out,
    {
      ok,
      mode: 'workspace',
      workspaceDir,
      policyPath,
      integrity: {
        ok: integrityOk,
        claimedPolicyId: claimedId,
        recomputedPolicyId: recomputedId,
        ...(integrityOk ? {} : { tampered: true }),
      },
      ...(driftReport !== null
        ? {
            drift: {
              checked: true,
              drifted: driftReport.drifted,
              onDiskShape: driftReport.onDiskShape,
              regeneratedShape: driftReport.regeneratedShape,
              generator: generatorId,
            },
          }
        : {
            drift: { checked: false },
          }),
    },
    humanLines,
  );

  return ok ? 0 : 1;
}

// ── Subcommand: diff ────────────────────────────────────────────────────

async function runCmdDiff(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length < 2) {
    emitError(out, 'diff: <a.json> <b.json> required', 'ERR_USAGE');
    return 2;
  }
  const detail = argv.includes('--detail');
  const a = JSON.parse(await fs.readFile(resolvePath(positional[0]!), 'utf-8')) as PolicyIR;
  const b = JSON.parse(await fs.readFile(resolvePath(positional[1]!), 'utf-8')) as PolicyIR;
  const diff = computePolicyDiff(a, b, detail);
  emit(
    out,
    {
      ok: true,
      a: { policyId: a.policyId, generatedAt: a.generatedAt },
      b: { policyId: b.policyId, generatedAt: b.generatedAt },
      changed: diff.changed,
      tools: diff.tools,
      denyRules: diff.denyRules,
    },
    [
      `openclaw-policy diff`,
      `  a: ${a.policyId} (${a.generatedAt})`,
      `  b: ${b.policyId} (${b.generatedAt})`,
      diff.changed ? '  changes:' : '  no changes',
      ...renderEntityDiffLines('tools', diff.tools, detail),
      ...renderEntityDiffLines('deny', diff.denyRules, detail),
    ],
  );
  return 0;
}

interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

interface ModifiedEntry {
  readonly id: string;
  readonly fields: readonly FieldChange[];
}

interface EntityDiff {
  readonly added: string[];
  readonly removed: string[];
  /**
   * When `--detail` is on, each entry carries a `fields` array;
   * otherwise the entry is `{id, fields: []}` so the JSON shape stays
   * stable. Consumers that only want IDs read `.modified.map(m => m.id)`.
   */
  readonly modified: ModifiedEntry[];
}

interface PolicyDiff {
  readonly changed: boolean;
  readonly tools: EntityDiff;
  readonly denyRules: EntityDiff;
}

function computePolicyDiff(a: PolicyIR, b: PolicyIR, detail: boolean): PolicyDiff {
  const diff = (
    arr1: readonly { id: string }[],
    arr2: readonly { id: string }[],
  ): EntityDiff => {
    const m1 = new Map(arr1.map((x) => [x.id, x]));
    const m2 = new Map(arr2.map((x) => [x.id, x]));
    const added: string[] = [];
    const removed: string[] = [];
    const modified: ModifiedEntry[] = [];
    for (const id of m2.keys()) {
      const before = m1.get(id);
      const after = m2.get(id);
      if (before === undefined) {
        added.push(id);
      } else if (JSON.stringify(before) !== JSON.stringify(after)) {
        const fields = detail ? diffFields(before, after as Record<string, unknown>) : [];
        modified.push({ id, fields });
      }
    }
    for (const id of m1.keys()) {
      if (!m2.has(id)) removed.push(id);
    }
    return { added, removed, modified };
  };
  const tools = diff(a.tools, b.tools);
  const denyRules = diff(a.denyRules, b.denyRules);
  const changed =
    tools.added.length + tools.removed.length + tools.modified.length +
    denyRules.added.length + denyRules.removed.length + denyRules.modified.length > 0;
  return { changed, tools, denyRules };
}

/**
 * Field-level diff for two objects with the same id. Reports every
 * key whose JSON-canonical value differs. Excludes the `id` field
 * (already used to align the entries).
 */
function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const fields: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('id');
  for (const key of [...keys].sort()) {
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      fields.push({ field: key, before: b, after: a });
    }
  }
  return fields;
}

function renderEntityDiffLines(
  label: string,
  d: EntityDiff,
  detail: boolean,
): string[] {
  const lines: string[] = [];
  if (d.added.length > 0) lines.push(`    + ${label}: ${d.added.join(', ')}`);
  if (d.removed.length > 0) lines.push(`    - ${label}: ${d.removed.join(', ')}`);
  if (d.modified.length > 0) {
    if (detail) {
      lines.push(`    ~ ${label}:`);
      for (const m of d.modified) {
        lines.push(`        ${m.id}`);
        for (const f of m.fields) {
          lines.push(
            `          ${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`,
          );
        }
      }
    } else {
      lines.push(`    ~ ${label}: ${d.modified.map((m) => m.id).join(', ')}`);
    }
  }
  return lines;
}

// ── Subcommand: evaluate ────────────────────────────────────────────────

async function runCmdEvaluate(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const irPath = positional[0];
  const toolId = positional[1];
  if (irPath === undefined || toolId === undefined) {
    emitError(out, 'evaluate: <policy-ir-path> <tool-id> required', 'ERR_USAGE');
    return 2;
  }
  const argsFlag = pickFlag(argv, '--args');
  let args: Record<string, unknown> | undefined;
  if (argsFlag !== undefined) {
    try {
      args = JSON.parse(argsFlag) as Record<string, unknown>;
    } catch (err) {
      emitError(out, `--args must be valid JSON: ${err instanceof Error ? err.message : String(err)}`, 'ERR_PARSE');
      return 2;
    }
  }
  const ir = JSON.parse(await fs.readFile(resolvePath(irPath), 'utf-8')) as PolicyIR;
  const call: ToolCallInput = args !== undefined ? { toolId, args } : { toolId };
  const decision = evaluateDecision(ir, call);
  emit(
    out,
    {
      ok: true,
      toolId,
      policyId: ir.policyId,
      decision,
    },
    [
      `openclaw-policy evaluate ${toolId}`,
      `  policyId: ${ir.policyId}`,
      `  decision: ${decision.kind}${decision.kind === 'deny' || decision.kind === 'requires-approval' ? ` — ${decision.reason}` : ''}`,
    ],
  );
  return 0;
}

// ── Subcommand: list-generators ─────────────────────────────────────────

async function runCmdListGenerators(
  _argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const generators = listPolicyGenerators();
  emit(
    out,
    {
      ok: true,
      count: generators.length,
      generators: generators.map((g) => ({
        id: g.id,
        description: g.description,
        sdkVersion: g.requires?.sdkVersion ?? null,
      })),
    },
    [
      `openclaw-policy: ${generators.length} registered generator(s)`,
      ...generators.map((g) => `  ${g.id}  ${g.description}`),
    ],
  );
  return 0;
}

// ── Help ────────────────────────────────────────────────────────────────

function printHelp(out: OutputContext): void {
  if (out.mode === 'json') {
    out.stdout.write(
      JSON.stringify({
        bin: 'openclaw-policy',
        usage: 'openclaw-policy <subcommand> [args]',
        subcommands: ['generate', 'check', 'diff', 'evaluate', 'list-generators', 'help'],
      }) + '\n',
    );
    return;
  }
  safeWrite(
    out.stdout,
    [
      'openclaw-policy — generate + verify + evaluate PolicyIR',
      '',
      'Usage:',
      '  openclaw-policy generate <workspace-dir> [--generator <id>] [--out <path>]',
      '      Walk the workspace, dispatch to the registered generator, emit PolicyIR.',
      '  openclaw-policy check <policy-path-or-workspace-dir> [--policy <path>] [--no-drift] [--generator <id>]',
      '      File mode (path → file): integrity only — verify policyId hash matches body.',
      '      Workspace mode (path → dir): integrity AND drift — regenerate from sources,',
      '      compare shape hash against on-disk policy.jsonc. Exit 1 on tamper or drift.',
      '  openclaw-policy diff <a.json> <b.json> [--detail]',
      '      Semantic diff: added/removed/changed tools and deny rules.',
      '      With --detail: per-field changes for modified entries.',
      '  openclaw-policy evaluate <policy-ir.json> <tool-id> [--args <json>]',
      '      Compute Decision (allow / deny / requires-approval / params).',
      '  openclaw-policy list-generators',
      '      Print registered generators (id + description).',
      '  openclaw-policy help',
      '',
      'Exit codes:',
      '  0  success',
      '  1  policy violation (tampered IR, denied call, mismatched hash)',
      '  2  argument / parse / I/O error',
      '',
    ].join('\n'),
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickFlag(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

// ── Dispatch ────────────────────────────────────────────────────────────

/**
 * Install an `'error'` handler on stdout so async EPIPE (the typical
 * `openclaw-policy ... | head -1` shape) is swallowed instead of
 * crashing the process. Idempotent: if a handler is already present,
 * leave it alone — test harnesses that swap stdout are responsible
 * for their own teardown. Returns a teardown function.
 */
function installPipeGuard(stream: NodeJS.WritableStream): () => void {
  // Some streams (test mocks) don't have an on() method; skip safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = stream as any;
  if (typeof s.on !== 'function' || typeof s.off !== 'function') {
    return () => {};
  }
  const handler = (err: NodeJS.ErrnoException): void => {
    if (isClosedPipeError(err)) return; // swallow
    // Re-throw via emit to default error handling — but since we're
    // already in an 'error' event, the safest thing is to exit non-zero.
    // Caller's outer try/catch in runCli won't see this; surface it
    // via stderr and exit.
    try {
      process.stderr.write(`ERR_INTERNAL: ${err.message}\n`);
    } catch {
      // stderr also closed; nothing we can do.
    }
    process.exitCode = 2;
  };
  s.on('error', handler);
  return () => s.off('error', handler);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const out = makeOutput(argv);
  const teardownStdout = installPipeGuard(out.stdout);
  const teardownStderr = installPipeGuard(out.stderr);
  // Strip global flags before subcommand dispatch.
  const filtered = argv.filter((a) => a !== '--json' && a !== '--human');
  const subcmd = filtered[0];
  const rest = filtered.slice(1);
  try {
    switch (subcmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        printHelp(out);
        return 0;
      case 'generate':
        return await runCmdGenerate(rest, out);
      case 'check':
        return await runCmdCheck(rest, out);
      case 'diff':
        return await runCmdDiff(rest, out);
      case 'evaluate':
        return await runCmdEvaluate(rest, out);
      case 'list-generators':
        return await runCmdListGenerators(rest, out);
      default:
        emitError(out, `unknown subcommand: ${subcmd}. Try "openclaw-policy help".`, 'ERR_UNKNOWN_SUBCOMMAND');
        return 2;
    }
  } catch (err) {
    if (isClosedPipeError(err)) return 0; // graceful exit on closed pipe
    // Preserve typed error codes (e.g. WorkspaceConfigError from
    // @openclaw/oc-path's loadWorkspaceConfig). Operators can branch
    // on WORKSPACE_CONFIG_PARSE_FAILED instead of catch-all ERR_INTERNAL.
    const code =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'ERR_INTERNAL';
    emitError(out, err instanceof Error ? err.message : String(err), code);
    return 2;
  } finally {
    teardownStdout();
    teardownStderr();
  }
}
