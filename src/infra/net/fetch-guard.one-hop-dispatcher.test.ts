import { describe, expect, it, vi } from "vitest";
import { fetchWithOneHopDispatcherAndSsrFGuard } from "./fetch-guard.js";
import type { LookupFn } from "./ssrf.js";

describe("fetchWithOneHopDispatcherAndSsrFGuard", () => {
  it("uses the selected dispatcher for each guarded hop and keeps redirect policy local", async () => {
    const localFetch = vi.fn(async () => new Response("must not send"));
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]) as unknown as LookupFn;

    const result = await fetchWithOneHopDispatcherAndSsrFGuard({
      url: "https://public.example/start",
      init: {
        method: "GET",
        headers: {
          authorization: "Bearer protected",
          accept: "application/json",
        },
      },
      fetchImpl: localFetch,
      lookupFn,
      oneHopDispatcher: { dispatch },
    });

    expect(await result.response.text()).toBe("ok");
    expect(lookupFn).not.toHaveBeenCalled();
    expect(result.finalUrl).toBe("https://other.example/final");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(localFetch).not.toHaveBeenCalled();

    const first = dispatch.mock.calls[0]?.[0];
    const second = dispatch.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      url: "https://public.example/start",
      init: { redirect: "manual" },
      networkGuard: {
        version: "network-guard/v1",
        target: { origin: "https://public.example" },
        route: { resolution: "connection-owner" },
        addressPolicy: {
          dnsRebinding: {
            enforcement: "connection-owner-required",
          },
        },
      },
    });
    expect(new Headers(first?.init.headers).get("authorization")).toBe("Bearer protected");
    expect(second).toMatchObject({
      url: "https://other.example/final",
      init: { redirect: "manual" },
      networkGuard: {
        version: "network-guard/v1",
        route: { resolution: "connection-owner" },
        addressPolicy: {
          dnsRebinding: {
            enforcement: "connection-owner-required",
          },
        },
        target: { origin: "https://other.example" },
      },
    });
    const redirectedHeaders = new Headers(second?.init.headers);
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json");

    await result.release();
  });
});
