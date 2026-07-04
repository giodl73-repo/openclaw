import { listCliCatalogSurfaces } from "./registry.js";

export type CliCatalogPromptSurface = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly dispatchMode: string;
  readonly target: string;
  readonly examples: readonly string[];
  readonly commandHints: readonly string[];
  readonly risk: string;
  readonly confirmationRequired: boolean;
};

export function listCliCatalogPromptSurfaces(): readonly CliCatalogPromptSurface[] {
  return listCliCatalogSurfaces().map((surface) => ({
    id: surface.id,
    title: surface.title,
    kind: surface.kind,
    dispatchMode: surface.dispatchMode,
    target: surface.target,
    examples: surface.examples,
    commandHints: surface.commandHints,
    risk: surface.risk,
    confirmationRequired: surface.confirmationRequired,
  }));
}
