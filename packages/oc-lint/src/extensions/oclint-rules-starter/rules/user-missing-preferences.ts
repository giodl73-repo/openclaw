/**
 * Rule: `starter-v0/user/missing-preferences-section`
 * Severity: info
 * Applies to: USER.md
 *
 * Flag: USER.md has no `## Preferences` section. Preferences carry
 * the user's stated working preferences (communication style, hours,
 * code-style); the agent reads them at session start. Missing means
 * the agent operates without user-context overrides.
 *
 * **Teaching pattern**: section-existence via `resolveOcPath`.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const userMissingPreferences: LintRule = {
  id: 'starter-v0/user/missing-preferences-section',
  severity: 'info',
  description: 'USER.md has no ## Preferences section',
  appliesTo: 'USER.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    if (resolveOcPath(ctx.ast, parseOcPath('oc://USER.md/preferences')) !== null) return [];
    // line:1 is the file-head anchor — the section is absent, so
    // there's no specific line to point at.
    return [
      {
        message: 'USER.md has no ## Preferences section',
        ocPath: 'oc://USER.md',
        line: 1,
        fixHint: 'add a `## Preferences` section listing your working preferences',
      },
    ];
  },
};
