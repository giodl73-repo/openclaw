import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import { splitModelRef } from "./subagent-spawn-plan.js";

export function buildDirectChildSessionPatch(
  patch: Record<string, unknown>,
): Partial<SessionEntry> {
  const entry: Partial<SessionEntry> = {};
  const spawnDepth = patch.spawnDepth;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth) && spawnDepth >= 0) {
    entry.spawnDepth = Math.floor(spawnDepth);
  }
  if (patch.subagentRole === "orchestrator" || patch.subagentRole === "leaf") {
    entry.subagentRole = patch.subagentRole;
  }
  if (patch.subagentControlScope === "children" || patch.subagentControlScope === "none") {
    entry.subagentControlScope = patch.subagentControlScope;
  }
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
  }
  if (typeof patch.spawnedWorkspaceDir === "string" && patch.spawnedWorkspaceDir.trim()) {
    entry.spawnedWorkspaceDir = patch.spawnedWorkspaceDir.trim();
  }
  if (typeof patch.spawnedCwd === "string" && patch.spawnedCwd.trim()) {
    entry.spawnedCwd = patch.spawnedCwd.trim();
  }
  Object.assign(
    entry,
    inheritedToolDenyPatch(normalizeInheritedToolDenylist(patch.inheritedToolDeny)),
    inheritedToolAllowPatch(normalizeInheritedToolAllowlist(patch.inheritedToolAllow)),
  );
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      const fallbackOriginProvider = normalizeOptionalString(
        patch.modelOverrideFallbackOriginProvider,
      );
      const fallbackOriginModel = normalizeOptionalString(patch.modelOverrideFallbackOriginModel);
      if (fallbackOriginProvider && fallbackOriginModel) {
        entry.modelOverrideFallbackOriginProvider = fallbackOriginProvider;
        entry.modelOverrideFallbackOriginModel = fallbackOriginModel;
      }
      if (provider) {
        entry.modelProvider = provider;
        entry.providerOverride = provider;
      }
    }
  }
  return entry;
}
