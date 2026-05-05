/**
 * `ocdoctor-fixers-yaml-starter` — fixer pack for `.lobster`
 * workflow files (YAML kind).
 *
 * Each fixer pairs with a `lobster-yaml-starter-v0` lint rule and
 * cites the originating openclaw/lobster issue.
 *
 * **v0 ship list** (2 fixers; the other 2 lint rules are advisory-only):
 *   - step/swap-shell-to-pipeline (#25, #26, #41) — error
 *   - step/dedupe-id (#76, #77) — warning, configurable strategy
 *
 * Lint rules without paired fixers (intentional):
 *   - step/mutually-exclusive-body — operator must decide which body to keep
 *   - step/undefined-stdin-ref — operator must rename ref or producing step
 *
 * @module ocdoctor-fixers-yaml-starter
 */

import type { OcPathFixerSpec } from '../../plugin-sdk/oc-doctor/types.js';
import { ocPathFixerContribution } from '../../plugin-sdk/oc-doctor/adapter.js';
import { registerDoctorHealthContribution } from '../../plugin-sdk/oc-doctor/registry.js';
import { stepDedupeId } from './fixers/step-dedupe-id.js';
import { stepSwapShellToPipeline } from './fixers/step-swap-shell-to-pipeline.js';

export const yamlStarterFixers: readonly OcPathFixerSpec<unknown>[] = [
  stepSwapShellToPipeline,
  stepDedupeId,
];

for (const spec of yamlStarterFixers) {
  registerDoctorHealthContribution(ocPathFixerContribution(spec));
}

export { stepDedupeId, stepSwapShellToPipeline };
