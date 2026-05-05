/**
 * `@openclaw/oc-doctor` — public SDK surface.
 *
 * @module @openclaw/oc-doctor
 */

/**
 * SDK version this build of `@openclaw/oc-doctor` exposes. Plugins
 * declare the version they were authored against via
 * `OcPathFixerSpec.requires.sdkVersion`; the host warns on mismatch
 * (semver-major bump = breaking change).
 *
 * Bumped on every breaking change to `OcPathFixerSpec` /
 * `DoctorContext` / `DoctorFinding` / `DoctorDetectResult`. In-tree
 * starter packs omit `requires` (they ship with the SDK, no
 * version-skew possible).
 */
export const SDK_VERSION = '0.1.0';

export type {
  DefaultFixerOptions,
  DoctorContext,
  DoctorFile,
  DoctorFinding,
  DoctorFixResult,
  DoctorHealthContribution,
  DoctorMutationEvent,
  FixerTier,
  OcPathFixerSpec,
} from './types.js';

export { ocPathFixerContribution, checkSdkCompat } from './adapter.js';

export {
  _clearDoctorHealthContributionRegistry,
  getDoctorHealthContribution,
  listDoctorHealthContributions,
  registerDoctorHealthContribution,
} from './registry.js';

export {
  resolveDoctorOverrides,
  type WorkspaceDoctorConfig,
} from './workspace-config.js';
