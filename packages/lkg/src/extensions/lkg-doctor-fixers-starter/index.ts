/**
 * `lkg-doctor-fixers-starter` — paired auto-fix pack for the
 * `lkg-lint-rules-starter` rules.
 *
 * **Strategic frame**: every substrate ships its own paired
 * auto-fixers alongside its lint rules. lkg's
 * fixers normalize content so the recovery pipeline succeeds —
 * scrub sentinels, strip BOMs.
 *
 * **Two fixers**, both auto-safe + idempotent:
 *   - `lkg/scrub-sentinel-from-tracked` — replaces sentinel with [REDACTED]
 *   - `lkg/strip-utf8-bom`              — strips leading BOM
 *
 * Self-registers on import.
 *
 * @module @openclaw/lkg/doctor-fixers-starter
 */

import {
  ocPathFixerContribution,
  registerDoctorHealthContribution,
  type DoctorHealthContribution,
  type OcPathFixerSpec,
} from '@openclaw/oc-doctor/plugin-sdk';

import { scrubSentinelFromTracked } from './fixers/scrub-sentinel-from-tracked.js';
import { stripUtf8Bom } from './fixers/strip-utf8-bom.js';

export const LKG_STARTER_FIXERS_V0: readonly OcPathFixerSpec<unknown>[] = [
  scrubSentinelFromTracked,
  stripUtf8Bom,
];

export const LKG_STARTER_FIXERS_V0_CONTRIBUTIONS: readonly DoctorHealthContribution[] =
  LKG_STARTER_FIXERS_V0.map(ocPathFixerContribution);

// Self-register on import.
for (const c of LKG_STARTER_FIXERS_V0_CONTRIBUTIONS) {
  registerDoctorHealthContribution(c);
}

export {
  scrubSentinelFromTracked,
  stripUtf8Bom,
};
