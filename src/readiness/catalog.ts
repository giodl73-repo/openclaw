import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { WORKSPACE_WRITABLE_CRITERION_ID } from "./conditions.js";

export type ReadinessCriterionSelection = "required" | "advisory" | "unselected";

export type ReadinessCriterionDescriptor = {
  id: string;
  description?: string;
  owner:
    | { kind: "core" }
    | { kind: "plugin"; pluginId: string; pluginName?: string }
    | { kind: "unresolved" };
  registered: boolean;
  selection: ReadinessCriterionSelection;
};

export type ReadinessCriterionCatalog = {
  catalogVersion: 1;
  criteria: ReadinessCriterionDescriptor[];
};

const CORE_CRITERIA: readonly ReadinessCriterionDescriptor[] = [
  {
    id: WORKSPACE_WRITABLE_CRITERION_ID,
    description: "Checks whether OpenClaw can write to the effective workspace.",
    owner: { kind: "core" },
    registered: true,
    selection: "unselected",
  },
];

function selectedCriteria(config: OpenClawConfig): Map<string, ReadinessCriterionSelection> {
  const selected = new Map<string, ReadinessCriterionSelection>();
  for (const id of config.gateway?.readiness?.advisoryCriteria ?? []) {
    selected.set(id, "advisory");
  }
  for (const id of config.gateway?.readiness?.requiredCriteria ?? []) {
    selected.set(id, "required");
  }
  return selected;
}

/** Enumerates selectable criteria without invoking their observation callbacks. */
export function buildReadinessCriterionCatalog(params: {
  config: OpenClawConfig;
  registry: Pick<PluginRegistry, "readinessCriteria">;
}): ReadinessCriterionCatalog {
  const selected = selectedCriteria(params.config);
  const descriptors = new Map<string, ReadinessCriterionDescriptor>();

  for (const descriptor of CORE_CRITERIA) {
    descriptors.set(descriptor.id, {
      ...descriptor,
      selection: selected.get(descriptor.id) ?? "unselected",
    });
  }
  for (const registration of params.registry.readinessCriteria) {
    descriptors.set(registration.id, {
      id: registration.id,
      description: registration.criterion.description,
      owner: {
        kind: "plugin",
        pluginId: registration.pluginId,
        ...(registration.pluginName ? { pluginName: registration.pluginName } : {}),
      },
      registered: true,
      selection: selected.get(registration.id) ?? "unselected",
    });
  }
  for (const [id, selection] of selected) {
    if (!descriptors.has(id)) {
      descriptors.set(id, {
        id,
        owner: { kind: "unresolved" },
        registered: false,
        selection,
      });
    }
  }

  return {
    catalogVersion: 1,
    criteria: Array.from(descriptors.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}
