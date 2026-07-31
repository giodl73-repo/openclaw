import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-contract.js";
import { createApplicationConfigCapability } from "./config.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function bootstrapResponse(
  serverVersion: string,
  overrides: Partial<ControlUiBootstrapConfig> = {},
): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    pluginFrameGrants: [],
    ...overrides,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApplicationConfigCapability", () => {
  it("returns null for a superseded bootstrap response", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    const firstRefresh = config.refresh();
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
  });

  it("normalizes policy settings constraints from bootstrap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        bootstrapResponse("policy", {
          policySettingsConstraints: {
            version: 1,
            mode: "active-policy-constraints",
            settings: {
              "tools.exec.host": {
                path: "tools.exec.host",
                policyPath: "tools.exec.allowHosts",
                state: "enabled",
                reason: "Policy only allows sandboxed hosts.",
                source: "oc://policy.jsonc/tools/exec/allowHosts",
                checkId: "policy/tools-exec-host-unapproved",
                allowedValues: ["sandbox", "gateway"],
                deniedValues: ["node"],
              },
            },
          },
        }),
      ),
    );

    const config = createApplicationConfigCapability({ basePath: "" });
    await expect(config.refresh()).resolves.toMatchObject({
      policySettingsConstraints: {
        settings: {
          "tools.exec.host": {
            allowedValues: ["sandbox", "gateway"],
            deniedValues: ["node"],
          },
        },
      },
    });
  });

  it("drops malformed policy settings constraints from bootstrap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        bootstrapResponse("bad-policy", {
          policySettingsConstraints: {
            version: 1,
            mode: "active-policy-constraints",
            settings: {
              "tools.exec.host": {
                path: "wrong.path",
                policyPath: "tools.exec.allowHosts",
                state: "enabled",
                reason: "Policy only allows sandboxed hosts.",
                source: "oc://policy.jsonc/tools/exec/allowHosts",
                checkId: "policy/tools-exec-host-unapproved",
              },
            },
          },
        }),
      ),
    );

    const config = createApplicationConfigCapability({ basePath: "" });
    await expect(config.refresh()).resolves.toMatchObject({
      policySettingsConstraints: { settings: {} },
    });
  });

  it("keeps host settings decisions without Policy-specific metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        bootstrapResponse("host-policy", {
          policySettingsConstraints: {
            version: 1,
            mode: "active-policy-constraints",
            settings: {
              "gateway.bind": {
                path: "gateway.bind",
                state: "readOnly",
                reason: "Lobster owns Gateway bind settings.",
                source: "lobster",
                broker: "lobster.policy.apply",
              },
            },
          },
        }),
      ),
    );

    const config = createApplicationConfigCapability({ basePath: "" });
    await expect(config.refresh()).resolves.toMatchObject({
      policySettingsConstraints: {
        settings: {
          "gateway.bind": {
            state: "readOnly",
            source: "lobster",
            broker: "lobster.policy.apply",
          },
        },
      },
    });
  });
});
