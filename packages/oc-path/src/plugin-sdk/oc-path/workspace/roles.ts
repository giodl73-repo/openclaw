/**
 * Canonical openclaw workspace artifact roles.
 *
 * The openclaw toolchain (oc-lint, oc-doctor, lkg-recovery, gateway
 * loaders) all recognize the same shared set of named files: agent
 * core (AGENTS.md / IDENTITY.md / etc.), config (`gateway.jsonc`,
 * `policy.jsonc`, …), sessions (`session*.jsonl`), workflows
 * (`*.lobster`). This module lifts that set into one structured place
 * so consumers don't drift.
 *
 * **Why it lives in oc-paths**: the workspace manifest's job is to
 * assign every file in the workspace its canonical `oc://...` URI.
 * That's oc-path applied to the filesystem — addressing, not
 * "workspace conventions" wearing addressing clothing. Putting the
 * role list here means a single dependency unifies every consumer on
 * the same addressing strategy.
 *
 * @module @openclaw/oc-path/workspace/roles
 */

import type { OcKind } from '../dispatch.js';

/**
 * A canonical openclaw artifact role. Anchored by basename match —
 * the matcher closures encode the same conventions used by oc-lint
 * starter rules' `appliesTo` strings.
 */
export interface OpenClawWorkspaceRole {
  /** Stable id for telemetry, audit, and consumer-side lookup. */
  readonly id: string;
  /** OcKind that drives the per-kind tooling (parser, tracker, fixer). */
  readonly kind: OcKind;
  /** Human description of what the artifact does in openclaw. */
  readonly description: string;
  /** Predicate over the basename — true means the file plays this role. */
  readonly matchesBasename: (basename: string) => boolean;
}

const CONFIG_PREFIX_RE = /^(?:gateway|openclaw|config)([.-][^.]+)?\.jsonc$/;
const POLICY_PREFIX_RE = /^policy([.-][^.]+)?\.jsonc$/;
// Accept any `.jsonl` as a session-log candidate. The earlier
// prefix-required form (`session|audit|events` + optional suffix) ruled
// out claude-code-style uuid-named logs (`f47ac10b-58cc-4372-...jsonl`)
// and timestamp-named logs (`2026-01-15T10-30-00.jsonl`). The jsonl
// content rules then determine whether the file actually parses as a
// session stream — a permissive name + strict content gate is more
// useful in practice than a strict name + permissive content gate.
const SESSION_JSONL_RE = /\.jsonl$/;

/**
 * The curated openclaw role set. Order is documentation-meaningful
 * (Tier 1 → Tier 4) but not behaviorally significant: matchers are
 * disjoint by basename so order doesn't change matching.
 */
export const OPENCLAW_WORKSPACE_ROLES: readonly OpenClawWorkspaceRole[] = [
  // Tier 1 — agent core (md). One per workspace at the root, plus
  // optional per-plugin copies under `plugins/<id>/AGENTS.md` etc.
  {
    id: 'agents.md',
    kind: 'md',
    description: 'Agent instructions (tools, boundaries, guidance)',
    matchesBasename: (n) => n === 'AGENTS.md',
  },
  {
    id: 'identity.md',
    kind: 'md',
    description: 'Agent identity (trust level, role)',
    matchesBasename: (n) => n === 'IDENTITY.md',
  },
  {
    id: 'memory.md',
    kind: 'md',
    description: 'Agent memory index',
    matchesBasename: (n) => n === 'MEMORY.md',
  },
  {
    id: 'skill.md',
    kind: 'md',
    description: 'Skill definition (tier, frontmatter)',
    matchesBasename: (n) => n === 'SKILL.md',
  },
  {
    id: 'tools.md',
    kind: 'md',
    description: 'Tools guidance table',
    matchesBasename: (n) => n === 'TOOLS.md',
  },
  {
    id: 'user.md',
    kind: 'md',
    description: 'User preferences',
    matchesBasename: (n) => n === 'USER.md',
  },
  {
    id: 'soul.md',
    kind: 'md',
    description: 'Agent soul (operator identity, mission)',
    matchesBasename: (n) => n === 'SOUL.md',
  },

  // Tier 2 — config (jsonc).
  {
    id: 'config.jsonc',
    kind: 'jsonc',
    description: 'Gateway / openclaw / config files (jsonc with comments)',
    matchesBasename: (n) => CONFIG_PREFIX_RE.test(n),
  },
  {
    id: 'policy.jsonc',
    kind: 'jsonc',
    description: 'Policy IR files',
    matchesBasename: (n) => POLICY_PREFIX_RE.test(n),
  },

  // Tier 3 — sessions / audit (jsonl).
  {
    id: 'session.jsonl',
    kind: 'jsonl',
    description: 'Agent session / audit / event logs',
    matchesBasename: (n) => SESSION_JSONL_RE.test(n),
  },

  // Tier 4 — lobster workflows (yaml-shaped).
  {
    id: 'lobster.workflow',
    kind: 'yaml',
    description: 'Lobster workflow (yaml-shaped)',
    matchesBasename: (n) => n.endsWith('.lobster'),
  },
];

/**
 * Find the role a basename plays, or `null` if no canonical role
 * matches. Callers passing `extraRoles` extend the canonical set
 * with deployment-specific artifacts.
 */
export function roleForBasename(
  basename: string,
  extraRoles: readonly OpenClawWorkspaceRole[] = [],
): OpenClawWorkspaceRole | null {
  for (const role of OPENCLAW_WORKSPACE_ROLES) {
    if (role.matchesBasename(basename)) return role;
  }
  for (const role of extraRoles) {
    if (role.matchesBasename(basename)) return role;
  }
  return null;
}
