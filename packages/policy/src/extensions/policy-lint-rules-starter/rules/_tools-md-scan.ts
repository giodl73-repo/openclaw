/**
 * Shared TOOLS.md scanner — walks the `## Tools` section's bodyText
 * yielding one record per `### name # meta` sub-heading. All policy
 * lint rules over TOOLS.md consume this so line-number arithmetic
 * and meta-line parsing live in one place.
 *
 * NOT exported from the lint pack's index — internal helper only.
 */
import type { OcAst } from '@openclaw/oc-path';

export interface ToolHeaderHit {
  /** Tool name as authored, e.g., `post-channel`. Empty if malformed. */
  readonly name: string;
  /** Meta string after the `#` separator, trimmed; empty if no meta. */
  readonly meta: string;
  /** 1-based line number in the source file. */
  readonly line: number;
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
    hits.push({ name, meta, line: block.line + 1 + i });
  }
  return hits;
}
