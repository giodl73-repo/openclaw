/**
 * `workspace.json` — per-workspace config at the workspace root.
 *
 * **Strategic frame**: oc-paths-substrate ships ONLY the loader and
 * the rule-id glob primitives. The schema is **additive**: each
 * substrate (pinch, oc-doctor, lkg, policy) defines its OWN section
 * type + resolver and reads its slice from the loaded config object.
 * No upfront declaration of which sections exist — adding a new
 * substrate doesn't touch this module.
 *
 *   import { loadWorkspaceConfig } from '@openclaw/oc-path/workspace';
 *   const config = await loadWorkspaceConfig(workspaceDir);
 *   // config is `Record<string, unknown> | null`; consumers cast
 *   // their own section:
 *   const lintSection = config?.['lint'] as MyLintConfigShape | undefined;
 *
 * **File location**: `<workspace-dir>/workspace.json`. Workspace-root
 * adjacent to `policy.jsonc`, `gateway.jsonc`, etc.
 *
 * **CLI precedence convention** (each substrate enforces its own):
 * command-line flags WIN over workspace.json defaults.
 *
 * @module @openclaw/oc-path/workspace/config
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseJsonc } from '../jsonc/parse.js';
import type { JsoncValue } from '../jsonc/ast.js';

/**
 * Conventional path under the workspace root where the config lives.
 *
 * Note: the file is named `workspace.json` for consumer ergonomics,
 * but the loader parses with the JSONC parser — comments and trailing
 * commas are accepted. Authors who want strict JSON can use either
 * extension; the loader is forgiving.
 */
export const WORKSPACE_CONFIG_PATH: 'workspace.json' = 'workspace.json';

/**
 * Generic loaded config — opaque shape. Each substrate casts its own
 * section to a typed shape it defines locally.
 */
export type WorkspaceConfig = Readonly<Record<string, unknown>>;

/**
 * Convert a typed `JsoncValue` tree to the plain JS shape consumers
 * expect (Record / array / scalar). Strips `line` metadata on the
 * way through — consumers reading `cfg.lint.skip` shouldn't see the
 * AST internals.
 */
function jsoncValueToJs(value: JsoncValue): unknown {
  switch (value.kind) {
    case 'object':
      return Object.fromEntries(
        value.entries.map((e) => [e.key, jsoncValueToJs(e.value)]),
      );
    case 'array':
      return value.items.map(jsoncValueToJs);
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
  }
}

/**
 * Read `workspace.json` from a workspace directory. Returns `null`
 * if the file doesn't exist (not an error — the config is optional).
 *
 * Uses the **JSONC parser** so the loader accepts comments + trailing
 * commas + other operator-friendly formatting that strict `JSON.parse`
 * would reject. Operators editing `workspace.json` shouldn't have to
 * re-learn JSON's narrow rules; jsonc is the substrate's universal
 * config dialect already (`gateway.jsonc`, `policy.jsonc`, etc.).
 *
 * Parse failures throw with a useful message; unknown sections pass
 * through transparently (additive schema). Hosts that want soft-fallback
 * (don't block lint/doctor/policy on a single typo) wrap the call in
 * try/catch — the library is unopinionated about whether a parse failure
 * should be fatal.
 */
export async function loadWorkspaceConfig(
  workspaceDir: string,
): Promise<WorkspaceConfig | null> {
  const path = resolvePath(workspaceDir, WORKSPACE_CONFIG_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  const result = parseJsonc(raw);
  // jsonc parser produces diagnostics for malformed bytes. If the
  // root failed to parse OR diagnostics are non-empty, surface as an
  // error — better to be loud than to silently fall back to {} and
  // hide a typo until something downstream fails.
  const fatal = result.diagnostics.find((d) => d.severity === 'error');
  if (fatal !== undefined) {
    throw new Error(`workspace.json parse failed at ${path}: ${fatal.message}`);
  }
  if (result.ast.root === null) {
    // Empty / whitespace-only file — treat as empty config.
    return {};
  }
  if (result.ast.root.kind !== 'object') {
    throw new Error(
      `workspace.json at ${path} must be a JSON object at the root (got ${result.ast.root.kind})`,
    );
  }
  return jsoncValueToJs(result.ast.root) as WorkspaceConfig;
}

/**
 * Glob match used for skip / only patterns. Supports `*` (any
 * chars) and `{a,b,c}` (alternation). General-purpose rule-id
 * matcher — kept here because every substrate's resolver uses it.
 */
export function matchRuleIdGlob(glob: string, ruleId: string): boolean {
  if (glob === ruleId || glob === '*') return true;
  let pattern = glob.replace(/[.+^$()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(/\{([^{}]+)\}/g, (_m, body: string) => {
    const alts = body.split(',').map((s) => s.trim());
    return `(?:${alts.join('|')})`;
  });
  pattern = pattern.replace(/\*/g, '.*');
  const re = new RegExp('^' + pattern + '$');
  return re.test(ruleId);
}

/**
 * Filter a registered rule/contribution list by allowlist globs.
 * Empty globs returns input unchanged (the empty-allowlist case is
 * "everything"). General-purpose; used by pinch, oc-doctor, others.
 */
export function filterByOnlyGlobs<T extends { id: string }>(
  items: readonly T[],
  onlyGlobs: readonly string[],
): readonly T[] {
  if (onlyGlobs.length === 0) return items;
  return items.filter((item) =>
    onlyGlobs.some((g) => matchRuleIdGlob(g, item.id)),
  );
}
