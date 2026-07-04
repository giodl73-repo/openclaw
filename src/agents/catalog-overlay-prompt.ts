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
  intent: string;
  examples: readonly string[];
  commandHints: readonly string[];
  risk: string;
  confirmationRequired: boolean;
}): string {
  const examples = surface.examples.length > 0 ? ` examples=${surface.examples.join(" | ")}` : "";
  const commands =
    surface.commandHints.length > 0 ? ` commands=${surface.commandHints.join(" | ")}` : "";
  return `- ${surface.id}: ${surface.title} [${surface.kind}, ${surface.dispatchMode}, target=${surface.target}, risk=${surface.risk}, confirmation=${surface.confirmationRequired}]${examples}${commands}`;
}

export function buildCliCatalogOverlayPromptSection(): string[] {
  const surfaces = listCliCatalogPromptSurfaces();
  return [
    "## CLI Catalog Overlay",
    "Use the CLI catalog overlay as metadata over existing OpenClaw command surfaces. Prefer a matched existing surface before inventing a new flow.",
    "Treat the overlay as a classifier and routing guide: describe the surface, choose the existing command or tool, and keep the execution path mechanical.",
    "If a request already matches an OpenClaw command surface, reuse that command surface instead of inventing a new API or prompt-only workflow.",
    "Use the existing surface metadata to decide intent, risk, and dispatch target. When in doubt, choose the smallest existing command surface that fits.",
    "",
    "### Catalog",
    ...surfaces.map(formatSurfaceLine),
    "",
  ];
}
