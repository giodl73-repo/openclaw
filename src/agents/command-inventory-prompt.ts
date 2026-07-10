import type { CliCatalogPluginCommand } from "../cli-catalog-overlay/plugin-commands.js";
import { listCommandPromptSurfaces } from "../cli-catalog-overlay/prompt-projection.js";

function formatSurfaceLine(surface: {
  id: string;
  target: string;
  risk: string;
  confirmationRequired: boolean;
}): string {
  return `- ${surface.id}->${surface.target} risk=${surface.risk} confirmation=${surface.confirmationRequired ? "user" : "none"}`;
}

export function buildCommandInventoryPromptSection(
  params: {
    availableTools?: ReadonlySet<string>;
    hostCliAvailable?: boolean;
    pluginCommands?: readonly CliCatalogPluginCommand[];
    promptPluginIds?: ReadonlySet<string>;
  } = {},
): string[] {
  if (
    params.hostCliAvailable === false ||
    (params.availableTools && !params.availableTools.has("exec"))
  ) {
    return [];
  }
  const surfaces = listCommandPromptSurfaces({
    pluginCommands: params.pluginCommands,
    promptPluginIds: params.promptPluginIds,
  });
  if (surfaces.length === 0) {
    return [];
  }
  return [
    "## OpenClaw Commands",
    "Use these existing commands for bounded operational requests instead of inventing a new flow.",
    "Do not run commands marked confirmation=user until the user explicitly confirms the action.",
    ...surfaces.map(formatSurfaceLine),
    "",
  ];
}
