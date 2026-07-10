import type { CliCatalogNodeCommand } from "../cli-catalog-overlay/node-commands.js";
/**
 * System-prompt contribution for a CLI-catalog-first OpenClaw command overlay.
 *
 * The overlay describes existing command surfaces and the commands they map to,
 * so the model can prefer catalog metadata over freeform invention.
 */
import type { CliCatalogPluginCommand } from "../cli-catalog-overlay/plugin-commands.js";
import { listCliCatalogPromptSurfaces } from "../cli-catalog-overlay/prompt-projection.js";

const TOOL_BACKED_SURFACE_TARGETS = new Set([
  "gateway",
  "process",
  "session_status",
  "sessions_spawn",
  "skill_workshop",
]);

function formatSurfaceLine(surface: {
  id: string;
  title: string;
  kind: string;
  dispatchMode: string;
  target: string;
  commandHints: readonly string[];
  risk: string;
  confirmationRequired: boolean;
}): string {
  const confirm = surface.confirmationRequired ? "1" : "0";
  if (surface.kind === "routed-operation") {
    return `- ${surface.id}->${surface.target} r=${surface.risk} c=${confirm}`;
  }
  const commands = surface.commandHints.join(" | ");
  return `- ${surface.id}: ${surface.title} target=${surface.target} r=${surface.risk} c=${confirm} commands=${commands}`;
}

function shouldRenderSurface(
  surface: {
    kind: string;
    target: string;
  },
  availableTools?: ReadonlySet<string>,
  hostCliAvailable = true,
): boolean {
  if (
    !hostCliAvailable &&
    (surface.kind === "routed-operation" || surface.kind === "plugin-command")
  ) {
    return false;
  }
  if (!availableTools) {
    return true;
  }
  if (surface.kind === "routed-operation" || surface.kind === "plugin-command") {
    return availableTools.has("exec");
  }
  if (surface.kind === "node-command") {
    return availableTools.has("nodes");
  }
  if (!TOOL_BACKED_SURFACE_TARGETS.has(surface.target)) {
    return true;
  }
  return availableTools.has(surface.target);
}

export function buildCliCatalogOverlayPromptSection(
  params: {
    availableTools?: ReadonlySet<string>;
    hostCliAvailable?: boolean;
    pluginCommands?: readonly CliCatalogPluginCommand[];
    promptPluginIds?: ReadonlySet<string>;
    nodeCommands?: readonly CliCatalogNodeCommand[];
    scope?: "default" | "node-operator";
  } = {},
): string[] {
  const surfaces = listCliCatalogPromptSurfaces({
    pluginCommands: params.pluginCommands,
    promptPluginIds: params.promptPluginIds,
    nodeCommands: params.nodeCommands,
    scope: params.scope,
  }).filter((surface) =>
    shouldRenderSurface(surface, params.availableTools, params.hostCliAvailable),
  );
  return [
    "## CLI Catalog Overlay",
    "Use catalog metadata to route bounded requests to existing OpenClaw commands/tools before inventing a flow.",
    "Full JSON has descriptors, command routes, routed ops, and agent/tool surfaces; this prompt is the lean projection.",
    "Use the smallest matching surface and keep execution on its current path.",
    "",
    "### Catalog",
    ...surfaces.map(formatSurfaceLine),
    "",
  ];
}
