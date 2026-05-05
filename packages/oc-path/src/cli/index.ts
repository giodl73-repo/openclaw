/**
 * `openclaw-path` CLI — shell-level access to the OcPath substrate
 * verbs. Self-hosters and editor extensions use it to inspect and
 * surgically edit workspace files without scripting against the SDK
 * directly.
 *
 * **Subcommands**:
 *   - `resolve <oc-path>`     — print the match at the path (or "not found")
 *   - `set <oc-path> <value>` — write a leaf at the path; supports `--dry-run`
 *   - `find <pattern>`        — enumerate matches for a wildcard/predicate path
 *   - `validate <oc-path>`    — parse-only; print structure (file/section/item/field)
 *   - `emit <file>`           — read + parseXxx + emitXxx; verifies byte-fidelity
 *
 * **Output**: TTY-aware. Defaults to human-readable when stdout is a
 * TTY; switches to JSON otherwise (so pipes don't get formatting noise).
 * `--json` and `--human` flags override the auto-detection.
 *
 * **Boundaries this CLI does NOT cross** (v0):
 *   - Doesn't know about LKG. `set` writes raw bytes through the
 *     substrate emit; if the file is LKG-tracked, the next observe
 *     call decides whether to promote / recover. `set --batch`
 *     (multiple ops staged through one LKG promote) lands alongside
 *     the LKG package — not v0.
 *   - Doesn't know about lint rules or doctor fixers — that's a
 *     different surface.
 *
 * @module @openclaw/oc-path/cli
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  OcPathError,
  REDACTED_SENTINEL,
  emitJsonc,
  emitJsonl,
  emitMd,
  emitYaml,
  findOcPaths,
  formatOcPath,
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseOcPath,
  parseYaml,
  resolveOcPath,
  setOcPath,
  type OcAst,
  type OcPath,
  type OcPathMatch,
  type SetResult,
} from '../plugin-sdk/oc-path/index.js';

/**
 * Output-boundary sentinel scrub. Replaces every occurrence of
 * `__OPENCLAW_REDACTED__` with `[REDACTED]` before writing to the
 * output stream. Defense-in-depth (CLI-OCPATH-030): even if a
 * future subcommand surfaces raw file content containing the
 * sentinel (e.g., a `cat`-like dump verb), the CLI MUST NOT echo
 * it verbatim. Pinch's CLI uses the same primitive — the function
 * is exported here so other openclaw-CLI authors can re-use it.
 */
const SCRUB_PLACEHOLDER = '[REDACTED]';
export function scrubSentinel(s: string): string {
  if (!s.includes(REDACTED_SENTINEL)) return s;
  return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}

// --- Output mode --------------------------------------------------------

interface OutputContext {
  readonly mode: 'human' | 'json';
  readonly stream: NodeJS.WriteStream;
}

function detectMode(args: ReadonlyMap<string, string | boolean>): 'human' | 'json' {
  if (args.get('json') === true) return 'json';
  if (args.get('human') === true) return 'human';
  return process.stdout.isTTY ? 'human' : 'json';
}

function emit(ctx: OutputContext, value: unknown, humanFallback?: () => string): void {
  if (ctx.mode === 'json') {
    ctx.stream.write(scrubSentinel(JSON.stringify(value, null, 2)) + '\n');
    return;
  }
  if (humanFallback !== undefined) {
    ctx.stream.write(scrubSentinel(humanFallback()) + '\n');
    return;
  }
  // Human mode but no formatter — fall back to JSON.
  ctx.stream.write(scrubSentinel(JSON.stringify(value, null, 2)) + '\n');
}

function emitError(message: string, json: boolean, code = 'ERR'): void {
  const scrubbedMessage = scrubSentinel(message);
  if (json) {
    process.stderr.write(
      JSON.stringify({ error: { code, message: scrubbedMessage } }) + '\n',
    );
  } else {
    process.stderr.write(`${code}: ${scrubbedMessage}\n`);
  }
}

// --- Arg parsing --------------------------------------------------------

interface ParsedArgs {
  readonly subcommand: string | null;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice();
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let subcommand: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        // boolean OR space-separated value.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(arg.slice(2), next);
          i++;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
      continue;
    }
    if (subcommand === null) {
      subcommand = arg;
    } else {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

// --- AST loading --------------------------------------------------------

async function loadAst(absPath: string, fileName: string): Promise<OcAst> {
  const raw = await fs.readFile(absPath, 'utf-8');
  const kind = inferKind(fileName);
  if (kind === 'jsonc') return parseJsonc(raw).ast;
  if (kind === 'jsonl') return parseJsonl(raw).ast;
  if (kind === 'yaml') return parseYaml(raw).ast;
  return parseMd(raw).ast;
}

function emitForKind(ast: OcAst): string {
  switch (ast.kind) {
    case 'jsonc':
      return emitJsonc(ast);
    case 'jsonl':
      return emitJsonl(ast);
    case 'yaml':
      return emitYaml(ast, { mode: 'render' });
    case 'md':
      return emitMd(ast);
  }
}

function resolveFsPath(path: OcPath, args: ParsedArgs): string {
  const cwd = (args.flags.get('cwd') as string | undefined) ?? process.cwd();
  const fileFlag = args.flags.get('file') as string | undefined;
  if (fileFlag !== undefined) return resolvePath(fileFlag);
  return resolvePath(cwd, path.file);
}

// --- Subcommand: resolve ------------------------------------------------

async function cmdResolve(args: ParsedArgs, ctx: OutputContext): Promise<number> {
  const pathStr = args.positional[0];
  if (pathStr === undefined) {
    emitError('resolve: missing <oc-path> argument', ctx.mode === 'json');
    return 2;
  }
  let ocPath: OcPath;
  try {
    ocPath = parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(`parse failed: ${err.message}`, ctx.mode === 'json', err.code);
      return 2;
    }
    throw err;
  }
  const fsPath = resolveFsPath(ocPath, args);
  const ast = await loadAst(fsPath, ocPath.file);
  const match = resolveOcPath(ast, ocPath);
  if (match === null) {
    emit(
      ctx,
      { resolved: false, ocPath: pathStr },
      () => `not found: ${pathStr}`,
    );
    return 1;
  }
  emit(
    ctx,
    { resolved: true, ocPath: pathStr, match },
    () => formatMatchHuman(match),
  );
  return 0;
}

function formatMatchHuman(match: NonNullable<ReturnType<typeof resolveOcPath>>): string {
  if (match.kind === 'leaf') {
    return `leaf @ L${match.line}: ${JSON.stringify(match.valueText)} (${match.leafType})`;
  }
  if (match.kind === 'node') {
    return `node @ L${match.line} [${match.descriptor}]`;
  }
  if (match.kind === 'insertion-point') {
    return `insertion-point @ L${match.line} [${match.container}]`;
  }
  return `root @ L${match.line}`;
}

// --- Subcommand: set ----------------------------------------------------

async function cmdSet(args: ParsedArgs, ctx: OutputContext): Promise<number> {
  const pathStr = args.positional[0];
  const value = args.positional[1];
  if (pathStr === undefined || value === undefined) {
    emitError('set: requires <oc-path> <value>', ctx.mode === 'json');
    return 2;
  }
  let ocPath: OcPath;
  try {
    ocPath = parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(`parse failed: ${err.message}`, ctx.mode === 'json', err.code);
      return 2;
    }
    throw err;
  }
  const fsPath = resolveFsPath(ocPath, args);
  const ast = await loadAst(fsPath, ocPath.file);
  const result: SetResult = setOcPath(ast, ocPath, value);
  if (!result.ok) {
    emit(
      ctx,
      { ok: false, reason: result.reason, detail: 'detail' in result ? result.detail : undefined },
      () => `set failed: ${result.reason}${'detail' in result && result.detail !== undefined ? ` — ${result.detail}` : ''}`,
    );
    return 1;
  }
  const newBytes = emitForKind(result.ast);
  // Warn if the kind's edit-then-emit path is lossy on formatting.
  // The substrate's setOcPath rebuilds raw via render mode, which
  // drops jsonc comments and yaml formatting. Self-hosters running
  // `openclaw-path set` on a commented file should know.
  const lossyKinds: ReadonlySet<OcAst['kind']> = new Set(['jsonc', 'yaml']);
  const formatLossWarning = lossyKinds.has(result.ast.kind)
    ? `note: ${result.ast.kind} edit-then-emit drops comments / original formatting (render mode)`
    : null;
  if (args.flags.get('dry-run') === true) {
    emit(
      ctx,
      {
        ok: true,
        dryRun: true,
        bytes: newBytes,
        ...(formatLossWarning !== null ? { warning: formatLossWarning } : {}),
      },
      () => {
        const lines = [`--dry-run: would write ${newBytes.length} bytes to ${fsPath}`];
        if (formatLossWarning !== null) lines.push(formatLossWarning);
        lines.push(newBytes);
        return lines.join('\n');
      },
    );
    return 0;
  }
  await fs.writeFile(fsPath, newBytes, 'utf-8');
  emit(
    ctx,
    {
      ok: true,
      dryRun: false,
      bytesWritten: newBytes.length,
      fsPath,
      ...(formatLossWarning !== null ? { warning: formatLossWarning } : {}),
    },
    () => {
      const lines = [`wrote ${newBytes.length} bytes to ${fsPath}`];
      if (formatLossWarning !== null) lines.push(formatLossWarning);
      return lines.join('\n');
    },
  );
  return 0;
}

// --- Subcommand: find ---------------------------------------------------

async function cmdFind(args: ParsedArgs, ctx: OutputContext): Promise<number> {
  const patternStr = args.positional[0];
  if (patternStr === undefined) {
    emitError('find: missing <pattern> argument', ctx.mode === 'json');
    return 2;
  }
  let pattern: OcPath;
  try {
    pattern = parseOcPath(patternStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(`parse failed: ${err.message}`, ctx.mode === 'json', err.code);
      return 2;
    }
    throw err;
  }
  const fsPath = resolveFsPath(pattern, args);
  const ast = await loadAst(fsPath, pattern.file);
  const matches = findOcPaths(ast, pattern);
  emit(
    ctx,
    {
      pattern: patternStr,
      count: matches.length,
      matches: matches.map((m: OcPathMatch) => ({
        path: formatOcPath(m.path),
        match: m.match,
      })),
    },
    () => {
      if (matches.length === 0) return `0 matches for ${patternStr}`;
      const lines = [`${matches.length} match${matches.length === 1 ? '' : 'es'} for ${patternStr}:`];
      for (const m of matches) {
        lines.push(`  ${formatOcPath(m.path)}  →  ${formatMatchHuman(m.match)}`);
      }
      return lines.join('\n');
    },
  );
  return matches.length > 0 ? 0 : 1;
}

// --- Subcommand: validate -----------------------------------------------

function cmdValidate(args: ParsedArgs, ctx: OutputContext): number {
  const pathStr = args.positional[0];
  if (pathStr === undefined) {
    emitError('validate: missing <oc-path> argument', ctx.mode === 'json');
    return 2;
  }
  try {
    const ocPath = parseOcPath(pathStr);
    emit(
      ctx,
      {
        valid: true,
        ocPath: pathStr,
        formatted: formatOcPath(ocPath),
        structure: {
          file: ocPath.file,
          section: ocPath.section,
          item: ocPath.item,
          field: ocPath.field,
          session: ocPath.session,
        },
      },
      () => {
        const lines = [
          `valid: ${pathStr}`,
          `  file:    ${ocPath.file}`,
        ];
        if (ocPath.section !== undefined) lines.push(`  section: ${ocPath.section}`);
        if (ocPath.item !== undefined) lines.push(`  item:    ${ocPath.item}`);
        if (ocPath.field !== undefined) lines.push(`  field:   ${ocPath.field}`);
        if (ocPath.session !== undefined) lines.push(`  session: ${ocPath.session}`);
        return lines.join('\n');
      },
    );
    return 0;
  } catch (err) {
    if (err instanceof OcPathError) {
      emit(
        ctx,
        { valid: false, code: err.code, message: err.message },
        () => `INVALID: ${err.code}: ${err.message}`,
      );
      return 1;
    }
    throw err;
  }
}

// --- Subcommand: emit ---------------------------------------------------

async function cmdEmit(args: ParsedArgs, ctx: OutputContext): Promise<number> {
  const fileArg = args.positional[0];
  if (fileArg === undefined) {
    emitError('emit: missing <file> argument', ctx.mode === 'json');
    return 2;
  }
  const fsPath = resolvePath(fileArg);
  const fileName = fsPath.split(/[\\/]/).pop() ?? fileArg;
  const ast = await loadAst(fsPath, fileName);
  const bytes = emitForKind(ast);
  // Always print bytes verbatim — this is a byte-fidelity diagnostic
  // tool. JSON mode wraps in a `{ "bytes": ... }` envelope.
  if (ctx.mode === 'json') {
    ctx.stream.write(JSON.stringify({ ok: true, kind: ast.kind, bytes }) + '\n');
  } else {
    ctx.stream.write(bytes);
  }
  return 0;
}

// --- Help ---------------------------------------------------------------

function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(`openclaw-path — shell-level access to OcPath substrate verbs

USAGE:
  openclaw-path <subcommand> [args...] [--cwd=<dir>] [--file=<path>] [--json|--human]

SUBCOMMANDS:
  resolve <oc-path>             Print the match at the path (or "not found")
  set <oc-path> <value>         Write a leaf at the path
                                  --dry-run    print bytes without writing
  find <pattern>                Enumerate matches for a wildcard/predicate path
  validate <oc-path>            Parse-only; print structure
  emit <file>                   Round-trip through parseXxx + emitXxx (byte-fidelity)

GLOBAL FLAGS:
  --cwd <dir>     Resolve OcPath file slot against this directory (default: process.cwd())
  --file <path>   Override the file slot's resolved path (absolute path access)
  --json          Force JSON output (default when stdout is not a TTY)
  --human         Force human output (default when stdout is a TTY)

EXAMPLES:
  openclaw-path validate 'oc://AGENTS.md/Tools/-1/risk'
  openclaw-path resolve  'oc://gateway.jsonc/version'
  openclaw-path find     'oc://session.jsonl/*/event' --file=./logs/session.jsonl
  openclaw-path set      'oc://gateway.jsonc/version' '2.0' --dry-run

EXIT CODES:
  0  success (resolve/find: at least one match; set: write succeeded)
  1  no match / set rejected by substrate (no system error)
  2  argument or parse error

NOTES:
  - 'set' writes raw bytes through the substrate emit, which applies
    the redaction-sentinel guard automatically.
  - LKG-tracked files are not yet integrated: 'set' bypasses the LKG
    promote/recover lifecycle in v0. The 'batch' subcommand for atomic
    multi-set through LKG lands alongside the @openclaw/lkg-recovery
    package.
`);
}

// --- Entry point --------------------------------------------------------

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const mode = detectMode(args.flags);
  const ctx: OutputContext = { mode, stream: process.stdout };

  if (args.subcommand === null || args.subcommand === 'help' || args.flags.get('help') === true) {
    printHelp(process.stdout);
    return 0;
  }

  try {
    switch (args.subcommand) {
      case 'resolve':
        return await cmdResolve(args, ctx);
      case 'set':
        return await cmdSet(args, ctx);
      case 'find':
        return await cmdFind(args, ctx);
      case 'validate':
        return cmdValidate(args, ctx);
      case 'emit':
        return await cmdEmit(args, ctx);
      default:
        emitError(`unknown subcommand: ${args.subcommand}`, mode === 'json');
        printHelp(process.stderr);
        return 2;
    }
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(err.message, mode === 'json', err.code);
      return 2;
    }
    if (err instanceof Error) {
      // Sentinel guard violations + emit failures land here.
      emitError(err.message, mode === 'json', (err as { code?: string }).code ?? 'ERR');
      return 2;
    }
    emitError(String(err), mode === 'json');
    return 2;
  }
}
