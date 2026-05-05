/**
 * `policy-doctor-fixers-starter` — paired auto-fix pack for the
 * `policy-lint-rules-starter` rules + drift-aware regeneration.
 *
 * **Strategic frame**: policy is the canonical plugin shape — the
 * plugin ships its own lint rules + doctor fixers from inside the
 * plugin's own package, demonstrating the full E2E shape: lint
 * detects → doctor fixes → policy regenerates.
 *
 * **Auto-safe pack** (`POLICY_STARTER_FIXERS_V0`):
 *   - `tools/migrate-sensitivity-syntax`    — paired with legacy-sensitivity-syntax
 *   - `tools/recommend-risk-from-caps`      — paired with missing-risk-level
 *   - `tools/bump-risk-on-irreversible`     — paired with irreversible-low-risk-mismatch
 *   - `policy/regenerate-on-drift`          — cross-file (uses siblingFiles)
 *
 * **Optional pack** (`POLICY_STARTER_FIXERS_V0_OPTIONAL`) — opt-in
 * because each makes a value decision the operator may want to
 * override:
 *   - `tools/snap-sensitivity-token`        — snap unknown sensitivity to target
 *   - `tools/snap-risk-level`               — snap R6+/negative to bound
 *   - `tools/dedupe-tool-id`                — destructive: removes earlier dups
 *
 * All seven use the canonical `OcPathFixerSpec` shape — no escape
 * hatch to raw `DoctorHealthContribution`. Cross-file drift detection
 * uses the new `siblingFiles` field on detect/fix input; async
 * generation uses the new `Promise<...>` return types.
 *
 * Self-registers on import.
 *
 * @module @openclaw/policy/doctor-fixers-starter
 */

import {
  ocPathFixerContribution,
  registerDoctorHealthContribution,
  type DoctorHealthContribution,
  type OcPathFixerSpec,
} from '@openclaw/oc-doctor/plugin-sdk';

import { policyRegenerateOnDrift } from './fixers/policy-regenerate-on-drift.js';
import { toolsBumpRiskOnIrreversible } from './fixers/tools-bump-risk-on-irreversible.js';
import { toolsDedupeToolId } from './fixers/tools-dedupe-tool-id.js';
import { toolsMigrateSensitivitySyntax } from './fixers/tools-migrate-sensitivity-syntax.js';
import { toolsRecommendRiskFromCaps } from './fixers/tools-recommend-risk-from-caps.js';
import { toolsSnapRiskLevel } from './fixers/tools-snap-risk-level.js';
import { toolsSnapSensitivityToken } from './fixers/tools-snap-sensitivity-token.js';

/**
 * Auto-safe pack — additive / idempotent / capability-derived
 * recommendations.
 */
export const POLICY_STARTER_FIXERS_V0: readonly OcPathFixerSpec<unknown>[] = [
  toolsMigrateSensitivitySyntax,
  toolsRecommendRiskFromCaps,
  toolsBumpRiskOnIrreversible,
  policyRegenerateOnDrift,
];

/**
 * Optional pack — operator opt-in because each makes a value
 * decision (snap-to-target, dedupe).
 */
export const POLICY_STARTER_FIXERS_V0_OPTIONAL: readonly OcPathFixerSpec<unknown>[] = [
  toolsSnapSensitivityToken,
  toolsSnapRiskLevel,
  toolsDedupeToolId,
];

/**
 * Auto-safe pack wrapped via `ocPathFixerContribution` — the form
 * the host's `registerDoctorHealthContribution` slot accepts.
 */
export const POLICY_STARTER_FIXERS_V0_CONTRIBUTIONS: readonly DoctorHealthContribution[] =
  POLICY_STARTER_FIXERS_V0.map(ocPathFixerContribution);

// Self-register on import.
for (const c of POLICY_STARTER_FIXERS_V0_CONTRIBUTIONS) {
  registerDoctorHealthContribution(c);
}

export {
  policyRegenerateOnDrift,
  toolsBumpRiskOnIrreversible,
  toolsDedupeToolId,
  toolsMigrateSensitivitySyntax,
  toolsRecommendRiskFromCaps,
  toolsSnapRiskLevel,
  toolsSnapSensitivityToken,
};
