import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { CONTINUITY_PUBLICATION_PROVIDER_VERSION } from "./publication-provider.js";

const mocks = vi.hoisted(() => ({
  resolveOwners: vi.fn(),
  resolveRegistry: vi.fn(),
}));

vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginIds: mocks.resolveOwners,
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRegistry,
}));

import { resolveContinuityPublicationProviderRuntimeV1 } from "./publication-provider-runtime.js";

const config = {
  continuity: {
    level: "portable",
    publicationProvider: "example/continuity",
  },
} satisfies OpenClawConfig;

beforeEach(() => {
  mocks.resolveOwners.mockReset();
  mocks.resolveRegistry.mockReset();
});

describe("continuity publication provider runtime", () => {
  it("loads only the unique manifest owner and freezes its runtime generation", () => {
    const registry = createEmptyPluginRegistry();
    registry.continuityPublicationProviders.push({
      pluginId: "example-provider",
      pluginName: "Example Provider",
      source: "C:\\plugins\\example-provider\\index.js",
      provider: {
        id: "example/continuity",
        version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
        generation: "provider-7",
        publish: vi.fn(),
        retrieve: vi.fn(),
      },
    });
    mocks.resolveOwners.mockReturnValue(["example-provider"]);
    mocks.resolveRegistry.mockReturnValue(registry);

    const resolved = resolveContinuityPublicationProviderRuntimeV1({
      config,
      workspaceDir: "C:\\workspace",
    });

    expect(mocks.resolveOwners).toHaveBeenCalledWith({
      config,
      workspaceDir: "C:\\workspace",
      contract: "continuityPublicationProviders",
      value: "example/continuity",
    });
    expect(mocks.resolveRegistry).toHaveBeenCalledWith({
      config,
      workspaceDir: "C:\\workspace",
      onlyPluginIds: ["example-provider"],
      activate: false,
      cache: false,
    });
    expect(resolved.reference).toEqual({
      pluginId: "example-provider",
      id: "example/continuity",
      version: CONTINUITY_PUBLICATION_PROVIDER_VERSION,
      generation: "provider-7",
    });
  });

  it("fails closed when manifest ownership is missing or ambiguous", () => {
    mocks.resolveOwners.mockReturnValueOnce([]).mockReturnValueOnce(["one", "two"]);

    expect(() => resolveContinuityPublicationProviderRuntimeV1({ config })).toThrow(
      expect.objectContaining({ code: "provider-not-found" }),
    );
    expect(() => resolveContinuityPublicationProviderRuntimeV1({ config })).toThrow(
      expect.objectContaining({ code: "provider-ambiguous" }),
    );
    expect(mocks.resolveRegistry).not.toHaveBeenCalled();
  });

  it("rejects a loaded plugin that does not register the declared provider", () => {
    mocks.resolveOwners.mockReturnValue(["example-provider"]);
    mocks.resolveRegistry.mockReturnValue(createEmptyPluginRegistry());

    expect(() => resolveContinuityPublicationProviderRuntimeV1({ config })).toThrow(
      expect.objectContaining({ code: "provider-not-found" }),
    );
  });
});
