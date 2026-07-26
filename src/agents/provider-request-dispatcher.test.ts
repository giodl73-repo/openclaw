import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderRequestDispatchersV1,
  ProviderRequestDispatcherError,
  registerProviderRequestDispatcherForOwnerV1,
  resolveProviderRequestDispatcherV1,
} from "./provider-request-dispatcher.js";

afterEach(() => {
  clearProviderRequestDispatchersV1();
});

function registration(
  overrides: Partial<{
    id: string;
    trafficPolicyId: string;
    trafficPolicyGeneration: string;
  }> = {},
) {
  return {
    version: "provider-request-dispatcher/v1" as const,
    id: overrides.id ?? "example/egress",
    trafficPolicyId: overrides.trafficPolicyId ?? "example/traffic",
    trafficPolicyGeneration: overrides.trafficPolicyGeneration ?? "generation-7",
    dispatch: vi.fn(async () => new Response("ok")),
  };
}

describe("provider-request dispatcher bindings", () => {
  it("resolves only the binding fenced to the selected traffic-policy generation", () => {
    const candidate = registration();
    const unregister = registerProviderRequestDispatcherForOwnerV1(
      "plugin:example-host",
      candidate,
    );

    const resolved = resolveProviderRequestDispatcherV1({
      bindingId: candidate.id,
      trafficPolicyId: candidate.trafficPolicyId,
      trafficPolicyGeneration: candidate.trafficPolicyGeneration,
    });
    expect(resolved).toMatchObject({
      id: "example/egress",
      owner: "plugin:example-host",
      trafficPolicyId: "example/traffic",
      trafficPolicyGeneration: "generation-7",
    });
    expect(resolved.dispatch).toBe(candidate.dispatch);

    unregister();
    expect(() =>
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: candidate.trafficPolicyGeneration,
      }),
    ).toThrowError(expect.objectContaining({ code: "binding-unavailable" }));
  });

  it("rejects stale generations and duplicate binding ownership", () => {
    const candidate = registration();
    registerProviderRequestDispatcherForOwnerV1("plugin:example-host", candidate);

    expect(() =>
      resolveProviderRequestDispatcherV1({
        bindingId: candidate.id,
        trafficPolicyId: candidate.trafficPolicyId,
        trafficPolicyGeneration: "generation-8",
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-policy-generation" }));
    expect(() =>
      registerProviderRequestDispatcherForOwnerV1("plugin:other-host", registration()),
    ).toThrowError(expect.objectContaining({ code: "duplicate-binding" }));
  });

  it.each([
    {
      name: "version",
      registration: { ...registration(), version: "provider-request-dispatcher/v2" },
    },
    { name: "binding ID", registration: registration({ id: "not valid" }) },
    {
      name: "traffic-policy generation",
      registration: registration({ trafficPolicyGeneration: "" }),
    },
  ])("rejects an invalid $name", ({ registration: invalid }) => {
    expect(() =>
      registerProviderRequestDispatcherForOwnerV1(
        "plugin:example-host",
        invalid as Parameters<typeof registerProviderRequestDispatcherForOwnerV1>[1],
      ),
    ).toThrow(ProviderRequestDispatcherError);
  });
});
