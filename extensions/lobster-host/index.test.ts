import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { LOBSTER_HOST_BUNDLE_MANIFEST_V1 } from "./package-api.js";

describe("lobster-host plugin", () => {
  const unregister = vi.fn();

  afterEach(() => {
    unregister.mockClear();
  });

  it("registers the bundle only while its startup service is active", async () => {
    const registerHostIntegrationBundle = vi.fn(() => unregister);
    const registerContinuityPublicationProvider = vi.fn();
    const registerService = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: {
        publicationRoot: path.resolve("durable-continuity"),
        providerGeneration: "provider-7",
      },
      registerHostIntegrationBundle,
      registerContinuityPublicationProvider,
      registerService,
    });

    plugin.register(api);
    const service = registerService.mock.calls[0]?.[0];
    expect(service?.id).toBe("lobster-host-package");
    expect(registerContinuityPublicationProvider).toHaveBeenCalledOnce();
    expect(registerContinuityPublicationProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "lobster/continuity",
      version: "continuity-publication-provider/v1",
      generation: "provider-7",
    });
    expect(registerHostIntegrationBundle).not.toHaveBeenCalled();

    await service?.start?.({
      config: {},
      stateDir: "/tmp/openclaw",
      logger: api.logger,
    });
    expect(registerHostIntegrationBundle).toHaveBeenCalledWith(LOBSTER_HOST_BUNDLE_MANIFEST_V1);

    await service?.stop?.({
      config: {},
      stateDir: "/tmp/openclaw",
      logger: api.logger,
    });
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("declares one complete provider-host snapshot", () => {
    expect(LOBSTER_HOST_BUNDLE_MANIFEST_V1.contributions).toStrictEqual([
      {
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "lobster/capi",
        version: "capi-model-provider-adapter/v1",
        required: true,
        readinessCriteria: ["model.provider.capi"],
      },
      {
        owner: "provider-request",
        kind: "credential-slot-resolver",
        id: "lobster/capi-token",
        version: "credential-slot-resolver/v1",
        required: true,
        readinessCriteria: ["provider.request.credentials.capi"],
      },
      {
        owner: "provider-request",
        kind: "provider-request-traffic-policy",
        id: "lobster/enterprise-egress",
        version: "provider-request-traffic-policy/v1",
        required: true,
        readinessCriteria: ["provider.request.policy.lobster"],
      },
      {
        owner: "provider-request",
        kind: "provider-request-dispatcher",
        id: "lobster/egress",
        version: "provider-request-dispatcher/v1",
        required: true,
        readinessCriteria: ["provider.request.dispatch.lobster"],
      },
      {
        owner: "provider-request",
        kind: "provider-request-carrier",
        id: "lobster/reverse-provider",
        version: "reverse-provider-dispatch/v1",
        required: true,
        readinessCriteria: ["provider.request.carrier.lobster"],
      },
      {
        owner: "continuity",
        kind: "continuity-publication-provider",
        id: "lobster/continuity",
        version: "continuity-publication-provider/v1",
        required: true,
        readinessCriteria: ["continuity.publication.lobster"],
      },
    ]);
  });

  it("keeps one bundle lease across overlapping fresh provider registries", async () => {
    const unregisterFirst = vi.fn();
    const registerFirst = vi.fn(() => unregisterFirst);
    const registerSecond = vi.fn(() => vi.fn());
    const registerServiceFirst = vi.fn();
    const registerServiceSecond = vi.fn();
    const pluginConfig = {
      publicationRoot: path.resolve("durable-continuity"),
      providerGeneration: "provider-7",
    };
    plugin.register(
      createTestPluginApi({
        pluginConfig,
        registerHostIntegrationBundle: registerFirst,
        registerService: registerServiceFirst,
      }),
    );
    plugin.register(
      createTestPluginApi({
        pluginConfig,
        registerHostIntegrationBundle: registerSecond,
        registerService: registerServiceSecond,
      }),
    );
    const first = registerServiceFirst.mock.calls[0]?.[0];
    const second = registerServiceSecond.mock.calls[0]?.[0];

    await first?.start?.({ config: {}, stateDir: "/tmp/openclaw", logger: console });
    await second?.start?.({ config: {}, stateDir: "/tmp/openclaw", logger: console });
    await first?.stop?.({ config: {}, stateDir: "/tmp/openclaw", logger: console });

    expect(registerFirst).toHaveBeenCalledOnce();
    expect(registerSecond).not.toHaveBeenCalled();
    expect(unregisterFirst).not.toHaveBeenCalled();

    await second?.stop?.({ config: {}, stateDir: "/tmp/openclaw", logger: console });
    expect(unregisterFirst).toHaveBeenCalledOnce();
  });
});
