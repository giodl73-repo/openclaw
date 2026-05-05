/**
 * `@openclaw/plugin-sdk/lkg` — public SDK surface.
 *
 * @module @openclaw/plugin-sdk/lkg
 */

/**
 * SDK version this build of `@openclaw/plugin-sdk/lkg` exposes.
 * Trackers declare the version they were authored against via
 * `LKGTracker.requires.sdkVersion`; the host warns on mismatch
 * (semver-major bump = breaking change).
 *
 * Bumped on every breaking change to `LKGTracker` / `LKGStore` /
 * `LKGObservation` / `LKGObserveOptions`. In-tree reference trackers
 * omit `requires` (they ship with the SDK; no version-skew possible).
 */
export const SDK_VERSION = '0.1.0';

export type {
  LKGActor,
  LKGEntry,
  LKGFingerprint,
  LKGFsStat,
  LKGObservation,
  LKGObserveOptions,
  LKGTracker,
  ValidationIssue,
  ValidationResult,
} from './types.js';
export { LKGError, type LKGErrorCode } from './types.js';

export { checkSdkCompat } from './compat.js';

export type {
  DeleteLabelResult,
  LKGStore,
  LabelEntry,
  PromoteAllOptions,
  PromoteAllResult,
  PromoteAllTrackerOutcome,
  RollbackResult,
} from './api.js';

export {
  resolveLkgOverrides,
  type ResolvedLkgOverrides,
  type WorkspaceLkgConfig,
} from './workspace-config.js';
