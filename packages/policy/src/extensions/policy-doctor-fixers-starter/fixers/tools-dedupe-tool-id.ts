/**
 * Fixer: `policy-starter-v0/tools/dedupe-tool-id`
 * Pairs with: `policy-starter-v0/tools/duplicate-tool-id`
 *
 * Remove all-but-the-last `### name` declarations when a tool id
 * appears more than once. Matches the extractor's last-writer-wins
 * semantics (POL-033) so the IR shape is preserved — the operator
 * just sees one declaration per tool in the source.
 *
 * **Optional** — destructive (deletes earlier H3 sub-blocks). Operator
 * opt-in only. Operators who disagree about which copy is canonical
 * edit by hand; this fixer is for the common case where the duplicate
 * is leftover from a copy-paste.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '@openclaw/oc-doctor/plugin-sdk';
import { scanToolHeaders } from './_tools-md-scan.js';

export const toolsDedupeToolId: OcPathFixerSpec = {
  id: 'policy-starter-v0/tools/dedupe-tool-id',
  description: 'Remove earlier duplicate `### name` declarations, keeping the last',
  severity: 'warning',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const hits = scanToolHeaders(ast);
    const lastByName = new Map<string, number>(); // name → line of LAST occurrence
    for (const h of hits) {
      if (h.name !== '') lastByName.set(h.name, h.line);
    }
    const findings = [];
    for (const h of hits) {
      if (h.name === '') continue;
      const lastLine = lastByName.get(h.name);
      if (lastLine === undefined || lastLine === h.line) continue; // this IS the last
      findings.push({
        match: {
          path: parseOcPath(`oc://TOOLS.md/Tools/${h.name}`),
          match: {
            kind: 'leaf' as const,
            valueText: h.name,
            leafType: 'string' as const,
            line: h.line,
          },
        },
        message: `tool '${h.name}' duplicate at line ${h.line}; last occurrence at line ${lastLine}`,
        fixHint: `remove this earlier declaration`,
      });
    }
    return findings;
  },

  fix({ raw, ast, match }) {
    if (ast.kind !== 'md') return raw;
    const hits = scanToolHeaders(ast);
    const target = hits.find((h) => h.line === match.match.line);
    if (target === undefined) return raw;
    // Only proceed if a later declaration with the same name exists.
    const hasLater = hits.some((h) => h.name === target.name && h.line > target.line);
    if (!hasLater) return raw; // already deduped or this is the last copy
    // Remove the H3 block from `### name ...` (target.line) up to but
    // not including the next `###` / `##` heading or end of file.
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(eol);
    const startIdx = target.line - 1;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.startsWith('### ') || l.startsWith('## ')) {
        endIdx = i;
        break;
      }
    }
    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx);
    return [...before, ...after].join(eol);
  },
};
