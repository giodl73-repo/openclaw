/**
 * Fixer: `starter-v0/skill/snap-tier`
 * Pairs with: `starter-v0/skill/invalid-tier-value`
 *
 * Snaps an invalid `tier:` frontmatter value to a configured target.
 * Same pattern + risk profile as memory/snap-scope.
 */
import { parseOcPath } from '@openclaw/oc-path';
import { STARTER_ALLOWED_SKILL_TIERS } from '@openclaw/oc-lint';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export interface SnapTierOptions {
  readonly targetTier: number;
  readonly allowedTiers: readonly number[];
}

const DEFAULTS: SnapTierOptions = {
  targetTier: 1,
  allowedTiers: STARTER_ALLOWED_SKILL_TIERS,
};

export const skillSnapTier: OcPathFixerSpec<SnapTierOptions> = {
  id: 'starter-v0/skill/snap-tier',
  description: 'Snap an invalid frontmatter `tier` value to a configured target',
  severity: 'warning',
  appliesTo: 'SKILL.md',
  defaultOptions: DEFAULTS,

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const tier = ast.frontmatter.find((e) => e.key === 'tier');
    if (tier === undefined) return [];
    const parsed = Number(tier.value);
    if (Number.isInteger(parsed) && DEFAULTS.allowedTiers.includes(parsed)) {
      return [];
    }
    return [
      {
        match: {
          path: parseOcPath('oc://SKILL.md/[frontmatter]/tier'),
          match: {
            kind: 'leaf',
            valueText: tier.value,
            leafType: 'string',
            line: tier.line,
          },
        },
        message: `SKILL.md frontmatter \`tier: ${tier.value}\` is not in allowed set`,
        fixHint: 'snap to a valid tier value',
      },
    ];
  },

  fix({ raw, ast, options }) {
    if (ast.kind !== 'md') return raw;
    const tier = ast.frontmatter.find((e) => e.key === 'tier');
    if (tier === undefined) return raw;
    const opts = options ?? DEFAULTS;
    const parsed = Number(tier.value);
    if (Number.isInteger(parsed) && opts.allowedTiers.includes(parsed)) {
      return raw;
    }
    const re = new RegExp(`^(\\s*tier\\s*:\\s*).*$`, 'm');
    let next = raw.replace(re, `$1${opts.targetTier}`);
    if (!ast.frontmatter.some((e) => e.key === '_auto_corrected')) {
      next = next.replace(
        /(\s*tier\s*:\s*[^\n]*\n)/,
        `$1_auto_corrected: true\n`,
      );
    }
    return next;
  },
};
