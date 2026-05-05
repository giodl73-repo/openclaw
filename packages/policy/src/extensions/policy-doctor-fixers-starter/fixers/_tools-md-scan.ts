/**
 * Shared TOOLS.md scanner — duplicates the lint pack's helper but
 * lives here so the fixer pack doesn't import across extensions.
 *
 * NOT exported from the fixer pack's index — internal helper only.
 */
import type { OcAst } from '@openclaw/oc-path';

export interface ToolHeaderHit {
  readonly name: string;
  readonly meta: string;
  /** 1-based line number in the source file. */
  readonly line: number;
  /**
   * Index in `block.bodyText.split('\n')` — fixer needs this to do
   * byte-precise rewrites against the source.
   */
  readonly bodyLineIdx: number;
}

export function scanToolHeaders(ast: OcAst): readonly ToolHeaderHit[] {
  if (ast.kind !== 'md') return [];
  const block = ast.blocks.find((b) => b.slug === 'tools');
  if (block === undefined) return [];
  const bodyLines = block.bodyText.split('\n');
  const hits: ToolHeaderHit[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    if (!line.startsWith('### ')) continue;
    const tail = line.slice(4);
    const nameMatch = tail.match(/^[\w-]+/);
    const name = nameMatch ? nameMatch[0] : '';
    const hashIdx = tail.indexOf('#');
    const meta = hashIdx === -1 ? '' : tail.slice(hashIdx + 1).trim();
    hits.push({ name, meta, line: block.line + 1 + i, bodyLineIdx: i });
  }
  return hits;
}

/**
 * Replace the line at the given absolute file-line number in `raw`.
 * Returns the new bytes. 1-based line numbering matches the AST.
 */
export function replaceLine(
  raw: string,
  line1Based: number,
  replacement: string,
): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  const idx = line1Based - 1;
  if (idx < 0 || idx >= lines.length) return raw;
  lines[idx] = replacement;
  return lines.join(eol);
}
