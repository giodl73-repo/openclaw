/**
 * Tracker registry — maps an oc-paths kind (md / jsonc / jsonl / yaml)
 * to a tracker factory. Default registry has one factory per kind
 * (the references in this directory). Callers override entries to plug
 * in domain-specific schema validators while keeping kind detection.
 *
 *   import { registerDefaultTracker } from '@openclaw/lkg/trackers';
 *   const store = new FsLKGStore({ root });
 *   registerDefaultTracker(store, '/abs/path/AGENTS.md');
 *   registerDefaultTracker(store, '/abs/path/gateway.jsonc');
 *
 * Behind the scenes: `inferKind('AGENTS.md')` → `'md'` → `mdTracker(...)`
 * → `store.register(tracker)`. The host doesn't have to teach the LKG
 * store about per-kind validation.
 *
 * @module @openclaw/lkg/trackers/registry
 */

import { basename } from 'node:path';
import type { OcKind, OcPath } from '@openclaw/oc-path';
import { inferKind } from '@openclaw/oc-path';
import type { LKGStore } from '../plugin-sdk/lkg/api.js';
import type { LKGTracker, ValidationResult } from '../plugin-sdk/lkg/types.js';
import { mdTracker, type MdTrackerSnapshot } from './md.js';
import { jsoncTracker, type JsoncTrackerSnapshot } from './jsonc.js';
import { jsonlTracker, type JsonlTrackerSnapshot } from './jsonl.js';
import { yamlTracker, type YamlTrackerSnapshot } from './yaml.js';

/**
 * The shape of a tracker-factory entry in the registry. Polymorphic
 * over `TParsed` per kind; the registry's lookup table loses the
 * narrow type intentionally — callers who need it use the per-kind
 * factories directly.
 */
export type TrackerFactoryOptions = {
  readonly path: string;
  readonly ocPath?: OcPath;
  // Per-kind `additionalCheck`s have different snapshot types; the
  // registry's generic facade can't carry a narrowed type. Callers
  // who need type-narrow `additionalCheck` skip the registry and call
  // the per-kind factory directly.
  readonly additionalCheck?: (snapshot: unknown) => ValidationResult;
};

export type TrackerFactory = (opts: TrackerFactoryOptions) => LKGTracker<unknown>;

/**
 * Default registry — one factory per oc-paths kind. The factory
 * objects are widened to a uniform `TrackerFactory` shape so the
 * registry table is homogeneous; the underlying per-kind factories
 * preserve their narrow `TParsed` types and remain available as
 * named exports for type-conscious callers.
 */
export const DEFAULT_TRACKER_FACTORIES: Readonly<Record<OcKind, TrackerFactory>> = {
  md: (opts) =>
    mdTracker({
      path: opts.path,
      ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
      ...(opts.additionalCheck !== undefined
        ? { additionalCheck: opts.additionalCheck as (s: MdTrackerSnapshot) => ValidationResult }
        : {}),
    }) as LKGTracker<unknown>,
  jsonc: (opts) =>
    jsoncTracker({
      path: opts.path,
      ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
      ...(opts.additionalCheck !== undefined
        ? { additionalCheck: opts.additionalCheck as (s: JsoncTrackerSnapshot) => ValidationResult }
        : {}),
    }) as LKGTracker<unknown>,
  jsonl: (opts) =>
    jsonlTracker({
      path: opts.path,
      ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
      ...(opts.additionalCheck !== undefined
        ? { additionalCheck: opts.additionalCheck as (s: JsonlTrackerSnapshot) => ValidationResult }
        : {}),
    }) as LKGTracker<unknown>,
  yaml: (opts) =>
    yamlTracker({
      path: opts.path,
      ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
      ...(opts.additionalCheck !== undefined
        ? { additionalCheck: opts.additionalCheck as (s: YamlTrackerSnapshot) => ValidationResult }
        : {}),
    }) as LKGTracker<unknown>,
};

export interface DefaultTrackerOptions {
  readonly ocPath?: OcPath;
  readonly additionalCheck?: (snapshot: unknown) => ValidationResult;
  /**
   * Override the default factory map. Pass a partial — the substrate
   * fills missing kinds from {@link DEFAULT_TRACKER_FACTORIES}.
   */
  readonly factories?: Readonly<Partial<Record<OcKind, TrackerFactory>>>;
  /**
   * Override the kind-detection function. Defaults to
   * {@link inferKind} from oc-paths. Callers with bespoke conventions
   * (e.g., `*.config.json` always JSONC) plug in their own.
   */
  readonly kindFor?: (path: string) => OcKind | null;
}

/**
 * Build a default tracker for the given path. Returns `null` if the
 * kind cannot be inferred (caller decides whether to fall back to a
 * trivial tracker, throw, or skip the path).
 */
export function defaultTrackerFor(
  path: string,
  opts: DefaultTrackerOptions = {},
): LKGTracker<unknown> | null {
  const kindFor = opts.kindFor ?? ((p) => inferKind(basename(p)));
  const kind = kindFor(path);
  if (kind === null) return null;
  const factories = { ...DEFAULT_TRACKER_FACTORIES, ...(opts.factories ?? {}) };
  const factory = factories[kind];
  if (factory === undefined) return null;
  return factory({
    path,
    ...(opts.ocPath !== undefined ? { ocPath: opts.ocPath } : {}),
    ...(opts.additionalCheck !== undefined ? { additionalCheck: opts.additionalCheck } : {}),
  });
}

/**
 * Convenience: build the default tracker for `path` and register it
 * with `store`. Returns `true` if a tracker was registered, `false` if
 * kind inference returned null.
 */
export function registerDefaultTracker(
  store: LKGStore,
  path: string,
  opts: DefaultTrackerOptions = {},
): boolean {
  const tracker = defaultTrackerFor(path, opts);
  if (tracker === null) return false;
  store.register(tracker);
  return true;
}
