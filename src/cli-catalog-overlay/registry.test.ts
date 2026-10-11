import { describe, expect, it } from "vitest";
import { getCliCatalogSurface, listCliCatalogSurfaces } from "./registry.js";

describe("CLI catalog overlay registry", () => {
  it("describes the initial metadata-first surface map", () => {
    const ids = listCliCatalogSurfaces().map((surface) => surface.id);

    expect(ids).toEqual([
      "skill_workshop",
      "session_status",
      "sessions_spawn",
      "process",
      "gateway",
    ]);
  });

  it("maps gateway as a hybrid command surface", () => {
    const gateway = getCliCatalogSurface("gateway");

    expect(gateway).toMatchObject({
      id: "gateway",
      dispatchMode: "hybrid",
      target: "gateway",
      source: "CLI descriptor: gateway",
      status: "stable",
      confirmationRequired: true,
      cliDescriptor: {
        name: "gateway",
        description: "Run, inspect, and query the WebSocket Gateway",
        hasSubcommands: true,
      },
    });
    expect(gateway?.commandHints).toContain("gateway restart");
    expect(gateway?.examples).toContain("restart the gateway");
  });
});
