import type { PluginRegistry } from "../plugins/registry-types.js";
import { WORKSPACE_WRITABLE_CRITERION_ID } from "./conditions.js";
import { HOST_BINDINGS_READY_CRITERION_ID } from "./host-bindings.js";

export const CORE_READINESS_CRITERION_IDS: ReadonlySet<string> = new Set([
  WORKSPACE_WRITABLE_CRITERION_ID,
  HOST_BINDINGS_READY_CRITERION_ID,
]);

export function buildReadinessCriterionCatalog(
  registry?: Pick<PluginRegistry, "readinessCriteria"> | null,
): ReadonlySet<string> {
  return new Set([
    ...CORE_READINESS_CRITERION_IDS,
    ...(registry?.readinessCriteria.map((entry) => entry.id) ?? []),
  ]);
}
