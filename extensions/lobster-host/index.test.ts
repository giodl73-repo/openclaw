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
    const registerService = vi.fn();
    const api = createTestPluginApi({
      registerHostIntegrationBundle,
      registerService,
    });

    plugin.register(api);
    const service = registerService.mock.calls[0]?.[0];
    expect(service?.id).toBe("lobster-host-package");
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
    expect(LOBSTER_HOST_BUNDLE_MANIFEST_V1.contributions).toHaveLength(7);
    expect(LOBSTER_HOST_BUNDLE_MANIFEST_V1.contributions.map((entry) => entry.id)).toEqual([
      "lobster/capi",
      "lobster/capi-token",
      "lobster/webiq",
      "lobster/webiq-key",
      "lobster/enterprise-egress",
      "lobster/egress",
      "lobster/reverse-provider",
    ]);
  });
});
