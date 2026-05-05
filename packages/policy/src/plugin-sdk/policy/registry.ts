/**
 * Generator registry — dispatch surface for `openclaw policy generate`.
 *
 * Each downstream consumer (claws / OPA / CEL / yaml shim / future)
 * ships its own `PolicyGenerator<TValidated>` impl and self-registers
 * via `registerPolicyGenerator(spec)`. The `openclaw policy generate`
 * CLI then looks up the right generator by id (or `--generator
 * <id>`) and dispatches to it.
 *
 * Why a registry rather than a hardcoded import: per the upstream
 * PR-1 frame, only the **types contract** + **CLI verb** + **registry
 * API** go upstream. Concrete generators stay per-consumer. A
 * registry decouples the CLI from any particular generator impl.
 *
 * @module @openclaw/plugin-sdk/policy/registry
 */

import type { PolicyGenerator } from './types.js';

/**
 * One registered generator. Adds id + description metadata so the
 * CLI can list available generators and operators can pick one
 * via `--generator <id>`.
 */
export interface PolicyGeneratorSpec<TValidated = unknown> {
  /** Stable id; e.g., 'md' for the markdown-shaped generator. */
  readonly id: string;
  readonly description: string;
  readonly generator: PolicyGenerator<TValidated>;
  /**
   * SDK version this generator was authored against. Optional —
   * omitting it means "trust the host." Mirrors the pattern in
   * lint rules + LKG trackers.
   */
  readonly requires?: {
    readonly sdkVersion: string;
  };
}

const REGISTRY = new Map<string, PolicyGeneratorSpec<unknown>>();

/**
 * Register a generator. Call this at module-init time so the CLI
 * sees the generator before dispatch. Re-registering the same id
 * replaces the previous spec (last-writer-wins; useful in tests).
 *
 *   registerPolicyGenerator({
 *     id: 'md',
 *     description: 'Markdown workspace → PolicyIR (claws-shaped)',
 *     generator: mdPolicyGenerator,
 *   });
 */
export function registerPolicyGenerator<TValidated>(
  spec: PolicyGeneratorSpec<TValidated>,
): void {
  REGISTRY.set(spec.id, spec as PolicyGeneratorSpec<unknown>);
}

/**
 * Look up a registered generator by id. Returns `null` if not
 * registered.
 */
export function getPolicyGenerator(
  id: string,
): PolicyGeneratorSpec<unknown> | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * Enumerate all registered generators. Used by the CLI's
 * `policy list-generators` subcommand and by hosts that want to
 * surface options to operators.
 */
export function listPolicyGenerators(): readonly PolicyGeneratorSpec<unknown>[] {
  return [...REGISTRY.values()];
}

/**
 * Test helper: clear the registry. NOT exported from the package
 * barrel; tests import from this module directly.
 */
export function _clearPolicyGeneratorRegistry(): void {
  REGISTRY.clear();
}
