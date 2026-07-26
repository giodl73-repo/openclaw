import {
  formatPluginReadinessCriterionId,
  PLUGIN_READINESS_LOCAL_ID_PATTERN,
} from "./readiness-id.js";
import type { OpenClawPluginReadinessCriterion } from "./readiness-types.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

const MAX_DESCRIPTION_LENGTH = 256;

export function createReadinessRegistrars(state: PluginRegistryState) {
  const registerReadinessCriterion = (
    record: PluginRecord,
    criterion: OpenClawPluginReadinessCriterion,
    pluginConfig?: Record<string, unknown>,
  ): void => {
    if (
      !criterion ||
      typeof criterion !== "object" ||
      typeof criterion.id !== "string" ||
      typeof criterion.description !== "string"
    ) {
      state.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "readiness criterion requires string id and description fields",
      });
      return;
    }
    const localId = criterion.id.trim().toLowerCase();
    const description = criterion.description.trim();
    if (!PLUGIN_READINESS_LOCAL_ID_PATTERN.test(localId)) {
      state.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "readiness criterion id must use lowercase letters, numbers, dots, dashes, or underscores: " +
          criterion.id,
      });
      return;
    }
    if (
      !description ||
      description.length > MAX_DESCRIPTION_LENGTH ||
      typeof criterion.check !== "function"
    ) {
      state.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "readiness criterion requires a bounded description and check function: " + localId,
      });
      return;
    }
    const id = formatPluginReadinessCriterionId(record.id, localId);
    if (state.registry.readinessCriteria.some((entry) => entry.id === id)) {
      state.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "readiness criterion already registered: " + id,
      });
      return;
    }
    state.registry.readinessCriteria.push({
      id,
      pluginId: record.id,
      pluginName: record.name,
      criterion: Object.freeze({ ...criterion, id: localId, description }),
      ...(pluginConfig ? { pluginConfig } : {}),
      source: record.source,
    });
  };

  return { registerReadinessCriterion };
}
