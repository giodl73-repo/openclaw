/**
 * `@openclaw/lkg/trackers` — reference tracker pack.
 *
 * Per-kind tracker factories that wire the oc-paths substrate's
 * `parseMd` / `parseJsonc` / `parseJsonl` / `parseYaml` into the
 * `LKGTracker` contract. Plus a registry helper that auto-detects
 * the kind from a path and registers the right factory's output with
 * an `LKGStore`.
 *
 * The default validation policy is "no error-severity diagnostics from
 * parse" — structural well-formedness only. Schema validation is a
 * caller concern; layer it via `additionalCheck` (per-kind factory)
 * or via a custom factory plugged into the registry.
 *
 * @module @openclaw/lkg/trackers
 */

export { mdTracker, type MdTrackerOptions, type MdTrackerSnapshot } from './md.js';
export { jsoncTracker, type JsoncTrackerOptions, type JsoncTrackerSnapshot } from './jsonc.js';
export { jsonlTracker, type JsonlTrackerOptions, type JsonlTrackerSnapshot } from './jsonl.js';
export { yamlTracker, type YamlTrackerOptions, type YamlTrackerSnapshot } from './yaml.js';
export {
  DEFAULT_TRACKER_FACTORIES,
  defaultTrackerFor,
  registerDefaultTracker,
  type DefaultTrackerOptions,
  type TrackerFactory,
  type TrackerFactoryOptions,
} from './registry.js';
export {
  buildWorkspaceManifest,
  registerOpenClawWorkspace,
  registerOpenClawWorkspaceFromDir,
  type OpenClawRegisteredEntry,
  type OpenClawSkippedEntry,
  type OpenClawWorkspaceRole,
  type RegisterOpenClawWorkspaceResult,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
} from './openclaw-workspace.js';
