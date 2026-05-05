/**
 * Rule: `lkg-starter-v0/lkg/empty-tracked-file`
 * Severity: info
 * Applies to: canonical core workspace md files
 *
 * Flag: a canonical-role file (AGENTS.md, SOUL.md, etc.) is empty
 * or contains only whitespace. The LKG store WILL observe and
 * promote the empty bytes (no validation failure), but downstream
 * consumers expecting structured content will see nothing to read.
 * Surfacing it pre-observe avoids the silent "tools list is empty,
 * but TOOLS.md exists" debugging session.
 *
 * Advisory-only: no auto-fix. Operators decide whether the empty
 * file is intentional (placeholder for future authoring) or a
 * mistake (failed save).
 */
import type { LintRule, LintFinding } from '@openclaw/oc-lint/plugin-sdk';

export const emptyTrackedFile: LintRule = {
  id: 'lkg-starter-v0/lkg/empty-tracked-file',
  severity: 'info',
  description:
    'Canonical workspace file (AGENTS.md / SOUL.md / etc.) is empty or whitespace-only',
  // Brace alternation matches the canonical core md role set.
  appliesTo: '{AGENTS.md,IDENTITY.md,MEMORY.md,SKILL.md,TOOLS.md,USER.md,SOUL.md}',
  check(ctx) {
    const findings: LintFinding[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (ctx.ast as any).raw as string | undefined;
    if (typeof raw !== 'string') return findings;
    if (raw.trim().length > 0) return findings;
    findings.push({
      message: `${ctx.fileName} is empty or whitespace-only; LKG observe will promote empty bytes, downstream consumers see no content`,
      ocPath: `oc://${ctx.fileName}`,
      line: 1,
      fixHint: 'add canonical content (e.g., a `## Boundaries` section) or delete the file if unused',
    });
    return findings;
  },
};
