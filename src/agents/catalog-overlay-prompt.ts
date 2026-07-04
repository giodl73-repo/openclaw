/**
 * System-prompt contribution for a CLI-catalog-first OpenClaw command overlay.
 *
 * The overlay describes existing command surfaces and the commands they map to,
 * so the model can prefer catalog metadata over freeform invention.
 */
import { listCliCatalogPromptSurfaces } from "../cli-catalog-overlay/prompt-projection.js";

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

export function buildCliCatalogOverlayPromptSection(): string[] {
  const surfaces = listCliCatalogPromptSurfaces();
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
