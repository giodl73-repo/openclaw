/**
 * `openclaw-pinch` CLI — shell-level access to the lint runner.
 * Self-hosters invoke it as a standalone bin (`openclaw-pinch ...`)
 * or as `openclaw pinch ...` once the umbrella dispatcher lands.
 *
 * Cargo:Clippy ↔ OpenClaw:Pinch — same precedent (a branded CLI
 * over an underlying lint framework).
 *
 * **Subcommands**:
 *
 *   `openclaw-pinch run [--rules <pack>] [--severity-min <level>] [<workspace-dir>]`
 *     Walk the workspace via `buildWorkspaceManifest`, parse each
 *     canonical file, run the starter rule pack (or `<pack>`), print
 *     diagnostics. Default `<workspace-dir>` = cwd.
 *
 *   `openclaw-pinch lint <file...> [--rules <pack>]`
 *     Lint specific files (no manifest walk). For one-off use.
 *
 *   `openclaw-pinch list-rules [--pack <name>]`
 *     Print the registered rule pack with id, severity, description,
 *     and `appliesTo` glob.
 *
 *   `openclaw-pinch help`
 *     Print usage and exit.
 *
 * **Output**: TTY-aware. Human-readable by default; `--json` switches
 * to machine-parseable. Exit codes:
 *   0 — clean (no findings, or only `info`-severity)
 *   1 — findings at warning or error severity
 *   2 — argument / parse / I/O error
 *
 * @module @openclaw/oc-lint/cli
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  REDACTED_SENTINEL,
  buildWorkspaceManifest,
  filterByOnlyGlobs,
  loadWorkspaceConfig,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
  type OcKind,
  type WorkspaceManifestEntry,
} from '@openclaw/oc-path';
import {
  resolveLintOverrides,
  type WorkspaceLintConfig,
} from '../plugin-sdk/oc-lint/workspace-config.js';
import { runLint, type LintFile } from '../oc-lint/runner.js';
// Importing each in-tree starter pack triggers self-registration with
// the global lint-rule registry; we then read everything via
// `listLintRules()`. Plugin authors who register additional rules
// at module-init time (e.g., `policy-substrate/extensions/policy-lint-rules`)
// are picked up automatically — `pinch run` grows as plugins land.
import '../extensions/oclint-rules-starter/index.js';
import '../extensions/oclint-rules-jsonc-starter/index.js';
import '../extensions/oclint-rules-jsonl-starter/index.js';
import '../extensions/oclint-rules-lobster-yaml-starter/index.js';
import { listLintRules } from '../plugin-sdk/oc-lint/registry.js';
import type { Diagnostic, LintRule, LintSeverity } from '../plugin-sdk/oc-lint/types.js';

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

/**
 * Output-boundary sentinel scrub. Replaces any occurrence of the
 * redaction sentinel (`__OPENCLAW_REDACTED__`) with a fixed
 * placeholder before writing to stdout. Defense-in-depth: even if
 * a future rule's diagnostic message echoes raw file content
 * containing the sentinel, the CLI MUST NOT print it verbatim.
 *
 * The substrate's emit-time guard catches sentinels during file
 * writes; this is the read-side equivalent for CLI output.
 */
const SCRUB_PLACEHOLDER = '[REDACTED]';
export function scrubSentinel(s: string): string {
  if (!s.includes(REDACTED_SENTINEL)) return s;
  return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}

function emit(out: OutputContext, payload: Record<string, unknown>, humanLines: readonly string[]): void {
  if (out.mode === 'json') {
    out.stdout.write(scrubSentinel(JSON.stringify(payload)) + '\n');
  } else {
    for (const line of humanLines) out.stdout.write(scrubSentinel(line) + '\n');
  }
}

// ── Glue ────────────────────────────────────────────────────────────────

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

async function entryToLintFile(entry: WorkspaceManifestEntry): Promise<LintFile> {
  const raw = await fs.readFile(entry.path, 'utf-8');
  return {
    name: entry.relPath.split('/').pop() ?? entry.relPath,
    ast: parseForKind(entry.role.kind, raw),
  };
}

const SEVERITY_RANK: Record<LintSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

function exitCodeFor(diagnostics: readonly Diagnostic[]): 0 | 1 {
  return diagnostics.some((d) => SEVERITY_RANK[d.severity] >= 1) ? 1 : 0;
}

// ── Subcommand: run ─────────────────────────────────────────────────────

async function runCmdRun(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const dir = resolvePath(positional[0] ?? process.cwd());
  const severityMin = parseSeverityMin(argv);
  const cliSkipIds = [...parseSkippedRuleIds(argv)];
  const cliSeverity = parseSeverityOverrides(argv);
  const cliOnlyGlobs = parseOnlyGlobs(argv);

  // Workspace config (durable defaults) — overlaid by CLI flags below.
  const workspaceConfig = await loadWorkspaceConfig(dir);
  const lintSection = workspaceConfig?.['lint'] as WorkspaceLintConfig | undefined;
  const allRules = listLintRules();
  const overrides = resolveLintOverrides(
    lintSection,
    { skip: cliSkipIds, severity: cliSeverity, only: cliOnlyGlobs },
    allRules.map((r) => r.id),
  );
  const rules = filterByOnlyGlobs(allRules, overrides.onlyGlobs);

  const manifest = await buildWorkspaceManifest(dir);
  const files = await Promise.all(manifest.entries.map(entryToLintFile));
  const result = runLint({
    rules,
    files,
    disabledRuleIds: overrides.disabledRuleIds,
    severityOverrides: overrides.severityOverrides,
  });

  const filtered = result.diagnostics.filter(
    (d) => SEVERITY_RANK[d.severity] >= severityMin,
  );

  // Visibility for "everything was disabled by workspace.json" — without
  // this, `lint.skip:["*"]` produces filesLinted=N, diagnostics=[] and the
  // operator sees a clean run when in fact NO rule fired. Surface the gap
  // in both JSON metadata and the human summary.
  const rulesRegistered = allRules.length;
  const rulesRun = rules.length - overrides.disabledRuleIds.size;

  emit(
    out,
    {
      ok: filtered.length === 0,
      workspaceDir: dir,
      filesLinted: files.length,
      rulesRegistered,
      rulesRun,
      rulesDisabledByConfig: overrides.disabledRuleIds.size,
      diagnostics: filtered.map((d) => ({
        ruleId: d.ruleId,
        severity: d.severity,
        fileName: d.fileName,
        line: d.line,
        ocPath: d.ocPath,
        message: d.message,
      })),
    },
    [
      `openclaw-pinch: ran ${rulesRun} rule(s) over ${files.length} file(s) in ${dir}`,
      ...(rulesRun === 0
        ? [`  WARNING: all ${rulesRegistered} registered rule(s) disabled by workspace.json or --skip`]
        : []),
      ...(filtered.length === 0
        ? ['  no findings ✓']
        : filtered.map(
            (d) =>
              `  [${d.severity}] ${d.fileName}:${d.line}  ${d.ruleId}  — ${d.message}`,
          )),
    ],
  );

  return exitCodeFor(filtered);
}

function parseSeverityMin(argv: readonly string[]): number {
  const idx = argv.indexOf('--severity-min');
  if (idx === -1) return 0;
  const v = argv[idx + 1];
  if (v === undefined) return 0;
  const r = SEVERITY_RANK[v as LintSeverity];
  return r ?? 0;
}

/**
 * Collect every `--skip <rule-id>` flag occurrence into a Set.
 * Repeatable: `pinch run --skip a --skip b` → {a, b}.
 */
function parseSkippedRuleIds(argv: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip' && argv[i + 1] !== undefined) {
      out.add(argv[i + 1]!);
      i++;
    }
  }
  return out;
}

/**
 * Collect every `--severity <rule-id>=<level>` override.
 * Repeatable: `pinch run --severity foo=warning --severity bar=error`.
 * Invalid level values are silently dropped (rule keeps declared severity).
 */
function parseSeverityOverrides(
  argv: readonly string[],
): Readonly<Record<string, LintSeverity>> {
  const out: Record<string, LintSeverity> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--severity' && argv[i + 1] !== undefined) {
      const [ruleId, level] = argv[i + 1]!.split('=', 2);
      if (
        ruleId !== undefined &&
        level !== undefined &&
        (level === 'info' || level === 'warning' || level === 'error')
      ) {
        out[ruleId] = level;
      }
      i++;
    }
  }
  return out;
}

/**
 * Filter the registered rule list down to ids matching any
 * `--only <pattern>` glob (repeatable). Pattern uses `*` wildcards.
 * If no `--only` is given, all rules pass.
 */
function applyOnlyFilter<T extends { id: string }>(
  rules: readonly T[],
  argv: readonly string[],
): readonly T[] {
  const patterns = parseOnlyGlobs(argv);
  return filterByOnlyGlobs(rules, patterns);
}

/**
 * Collect every `--only <pattern>` flag occurrence into an array.
 * Repeatable: `pinch run --only foo --only bar` → ['foo', 'bar'].
 */
function parseOnlyGlobs(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1] !== undefined) {
      out.push(argv[i + 1]!);
      i++;
    }
  }
  return out;
}

/**
 * Locate a workspace directory by walking up from a starting file/dir
 * looking for `workspace.json`. Returns the nearest containing dir
 * if found, otherwise the starting dir's parent (or cwd as last
 * resort). Used by `openclaw-pinch lint <files>` so that workspace config
 * applies even when no positional dir is given.
 */
async function findWorkspaceDir(startPath: string): Promise<string> {
  const abs = resolvePath(startPath);
  let cur = abs;
  // Walk up until root or workspace.json is found.
  for (let i = 0; i < 64; i++) {
    const parent = resolvePath(cur, '..');
    if (parent === cur) break; // hit filesystem root
    cur = parent;
    try {
      await fs.access(resolvePath(cur, 'workspace.json'));
      return cur;
    } catch {
      // not here; keep walking
    }
  }
  // Fall back to cwd.
  return process.cwd();
}

// ── Subcommand: lint (specific files) ───────────────────────────────────

async function runCmdLint(
  argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const filePaths = argv.filter((a) => !a.startsWith('-'));
  if (filePaths.length === 0) {
    emit(out, { ok: false, error: 'no files specified' }, [
      'openclaw-pinch lint: at least one file required',
    ]);
    return 2;
  }
  const cliSkipIds = [...parseSkippedRuleIds(argv)];
  const cliSeverity = parseSeverityOverrides(argv);
  const cliOnlyGlobs = parseOnlyGlobs(argv);
  // For `lint <files>` we don't have a workspace dir; scan up from
  // the first file to find the nearest workspace.json. Falls back
  // to cwd when nothing is found.
  const workspaceDir = await findWorkspaceDir(filePaths[0]!);
  const workspaceConfig = await loadWorkspaceConfig(workspaceDir);
  const lintSection = workspaceConfig?.['lint'] as WorkspaceLintConfig | undefined;
  const allRules = listLintRules();
  const overrides = resolveLintOverrides(
    lintSection,
    { skip: cliSkipIds, severity: cliSeverity, only: cliOnlyGlobs },
    allRules.map((r) => r.id),
  );
  const rules = filterByOnlyGlobs(allRules, overrides.onlyGlobs);
  const files: LintFile[] = [];
  for (const p of filePaths) {
    const raw = await fs.readFile(p, 'utf-8');
    const name = p.split(/[\\/]/).pop() ?? p;
    const kind = inferKindFromName(name);
    if (kind === null) {
      emit(out, { ok: false, error: `unknown kind: ${name}` }, [
        `openclaw-pinch lint: ${name}: cannot infer kind from extension`,
      ]);
      return 2;
    }
    files.push({ name, ast: parseForKind(kind, raw) });
  }
  const result = runLint({
    rules,
    files,
    disabledRuleIds: overrides.disabledRuleIds,
    severityOverrides: overrides.severityOverrides,
  });
  emit(
    out,
    {
      ok: result.diagnostics.length === 0,
      filesLinted: files.length,
      diagnostics: result.diagnostics.map((d) => ({
        ruleId: d.ruleId,
        severity: d.severity,
        fileName: d.fileName,
        line: d.line,
        ocPath: d.ocPath,
        message: d.message,
      })),
    },
    [
      `openclaw-pinch: ran ${rules.length} rule(s) over ${files.length} file(s)`,
      ...(result.diagnostics.length === 0
        ? ['  no findings ✓']
        : result.diagnostics.map(
            (d) =>
              `  [${d.severity}] ${d.fileName}:${d.line}  ${d.ruleId}  — ${d.message}`,
          )),
    ],
  );
  return exitCodeFor(result.diagnostics);
}

function inferKindFromName(name: string): OcKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.jsonc') || lower.endsWith('.json')) return 'jsonc';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.lobster'))
    return 'yaml';
  return null;
}

// ── Subcommand: list-rules ──────────────────────────────────────────────

async function runCmdListRules(
  _argv: readonly string[],
  out: OutputContext,
): Promise<number> {
  const rules: readonly LintRule[] = listLintRules() as readonly LintRule[];
  emit(
    out,
    {
      pack: 'starter-v0',
      count: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        severity: r.severity,
        appliesTo: r.appliesTo,
        description: r.description,
      })),
    },
    [
      `openclaw-pinch starter-v0: ${rules.length} rule(s)`,
      ...rules.map((r) => `  [${r.severity}] ${r.id}  appliesTo=${r.appliesTo}`),
    ],
  );
  return 0;
}

// ── Help ────────────────────────────────────────────────────────────────

function printHelp(out: OutputContext): void {
  if (out.mode === 'json') {
    out.stdout.write(
      JSON.stringify({
        bin: 'openclaw-pinch',
        usage: 'openclaw-pinch <subcommand> [args]',
        subcommands: ['run', 'lint', 'list-rules', 'help'],
      }) + '\n',
    );
    return;
  }
  out.stdout.write(
    [
      'openclaw-pinch — OpenClaw lint runner (Cargo:Clippy ↔ OpenClaw:Pinch)',
      '',
      'Usage:',
      '  openclaw-pinch run [--severity-min <level>] [--skip <id>]... [--only <pat>]... [--severity <id>=<level>]... [<workspace-dir>]',
      '      Walk the workspace manifest and lint every canonical artifact.',
      '  openclaw-pinch lint <file...> [--skip <id>]... [--only <pat>]... [--severity <id>=<level>]...',
      '      Lint specific files; kind inferred from extension.',
      '  openclaw-pinch list-rules',
      '      Print the registered rule pack.',
      '  openclaw-pinch help',
      '      Print this message.',
      '',
      'Rule selection:',
      '  --skip <rule-id>          Disable a rule (repeatable).',
      '  --only <pattern>          Allowlist by glob match against rule id (repeatable).',
      '  --severity <id>=<level>   Override a rule\'s severity at runtime',
      '                            (level: info | warning | error). Repeatable.',
      '  --severity-min <level>    Filter findings below this severity from output',
      '                            (level: info | warning | error).',
      '',
      'Output:',
      '  TTY-aware. Defaults to human-readable when stdout is a TTY;',
      '  switches to JSON otherwise. --json and --human override.',
      '',
      'Exit codes:',
      '  0  clean or only info-severity findings',
      '  1  warning or error findings',
      '  2  argument / parse / I/O error',
      '',
    ].join('\n'),
  );
}

// ── Dispatch ────────────────────────────────────────────────────────────

export async function runCli(argv: readonly string[]): Promise<number> {
  const out = makeOutput(argv);
  // Strip global flags (--json / --human) before subcommand dispatch
  // so `openclaw-pinch --json help` and `openclaw-pinch help --json` are equivalent.
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
      case 'run':
        return await runCmdRun(rest, out);
      case 'lint':
        return await runCmdLint(rest, out);
      case 'list-rules':
        return await runCmdListRules(rest, out);
      default:
        emit(
          out,
          { ok: false, error: `unknown subcommand: ${subcmd}` },
          [`openclaw-pinch: unknown subcommand "${subcmd}". Try "openclaw-pinch help".`],
        );
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Preserve the failure-mode code from typed substrate errors
    // (e.g. WorkspaceConfigError from @openclaw/oc-path). Without this
    // a malformed workspace.json collapses to a generic error and
    // operators can't distinguish operator-typo from substrate bug.
    const code =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'ERR_INTERNAL';
    emit(out, { ok: false, error: msg, code }, [`openclaw-pinch: error [${code}]: ${msg}`]);
    return 2;
  }
}
