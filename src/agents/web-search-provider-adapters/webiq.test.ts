import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";
import {
  WEBIQ_ADAPTER_VERSION,
  WEBIQ_API_KEY_SLOT_ID,
  WEBIQ_RESPONSE_BODY_MAX_BYTES,
  adaptWebIqResponseV1,
  prepareWebIqRequestV1,
  type WebIqAdapterConfigV1,
  type WebIqSearchRequestV1,
} from "./webiq.js";

type Fixture = {
  request: { config: WebIqAdapterConfigV1; request: WebIqSearchRequestV1 };
  expected: {
    url: string;
    credentialSlotRefs: string[];
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/webiq-web-search-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function slot(overrides: Partial<CredentialSlotReadinessV1> = {}): CredentialSlotReadinessV1 {
  return {
    slotId: WEBIQ_API_KEY_SLOT_ID,
    resolverId: "local/webiq-key",
    version: CREDENTIAL_SLOT_VERSION,
    resolverVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
    placement: "header",
    headerName: "x-apikey",
    allowedOrigins: ["https://api.microsoft.ai"],
    required: true,
    ...overrides,
  };
}

describe("WebIQ web-search provider adapter", () => {
  it("matches the portable request fixture without materializing credentials", () => {
    const prepared = prepareWebIqRequestV1({
      ...fixture.request,
      headers: {
        "x-apikey": "spoofed",
        authorization: "spoofed",
        cookie: "session=spoofed",
        "x-client-header": "spoofed",
      },
      credentialSlots: [slot()],
    });
    expect(prepared.adapterVersion).toBe(WEBIQ_ADAPTER_VERSION);
    expect(prepared.url).toBe(fixture.expected.url);
    expect(prepared.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual(fixture.expected.body);
    for (const [name, value] of Object.entries(fixture.expected.headers)) {
      expect(prepared.headers.get(name)).toBe(value);
    }
    expect(prepared.headers.get("x-apikey")).toBeNull();
    expect(prepared.headers.get("authorization")).toBeNull();
    expect(prepared.headers.get("cookie")).toBeNull();
    expect(prepared.headers.get("x-client-header")).toBeNull();
  });

  it("fails closed for the wrong header, origin, or broader slot", () => {
    for (const overrides of [
      { headerName: "x-api-key" },
      { allowedOrigins: ["https://other.example.com"] },
      { allowedOrigins: ["https://api.microsoft.ai", "https://other.example.com"] },
    ]) {
      expect(() =>
        prepareWebIqRequestV1({
          ...fixture.request,
          credentialSlots: [slot(overrides)],
        }),
      ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    }
  });

  it("rejects non-HTTPS endpoints, empty queries, and invalid bounds", () => {
    expect(() =>
      prepareWebIqRequestV1({
        config: { ...fixture.request.config, baseUrl: "http://api.microsoft.ai" },
        request: fixture.request.request,
        credentialSlots: [slot()],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    for (const request of [
      { ...fixture.request.request, query: " " },
      { ...fixture.request.request, maxResults: 51 },
      { ...fixture.request.request, maxLength: 500_001 },
      { ...fixture.request.request, contentFormat: "xml" as never },
      { ...fixture.request.request, region: 5 as never },
    ]) {
      expect(() =>
        prepareWebIqRequestV1({
          config: fixture.request.config,
          request,
          credentialSlots: [slot()],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid-request" }));
    }
  });

  it("owns WebIQ response filtering and normalized web-search results", async () => {
    const response = await adaptWebIqResponseV1(
      Response.json({
        webResults: [
          ...(fixture as Fixture & { response: { webResults: unknown[] } }).response.webResults,
          {
            title: "Filtered",
            url: "https://adult.example/",
            content: "Do not return.",
            isAdult: true,
          },
          { title: "Missing URL" },
        ],
      }),
      {
        query: fixture.request.request.query,
        maxResults: fixture.request.request.maxResults ?? 5,
      },
      42,
    );
    const payload = (await response.json()) as {
      query: string;
      provider: string;
      count: number;
      tookMs: number;
      externalContent: { untrusted: boolean; wrapped: boolean };
      results: Array<{ title: string; url: string; snippet: string; siteName?: string }>;
    };
    expect(payload).toMatchObject({
      query: fixture.request.request.query,
      provider: "webiq",
      count: 1,
      tookMs: 42,
      externalContent: { untrusted: true, wrapped: true },
    });
    expect(payload.results[0]).toMatchObject({
      url: "https://openclaw.ai/",
      siteName: "openclaw.ai",
    });
    expect(payload.results[0]?.title).toContain("OpenClaw");
    expect(payload.results[0]?.snippet).toContain("Hosted integration documentation.");
  });

  it("fails closed on provider errors, invalid JSON, and oversized responses", async () => {
    await expect(
      adaptWebIqResponseV1(
        new Response("unavailable", { status: 503 }),
        {
          query: "query",
          maxResults: 5,
        },
        0,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "provider-error" }));
    await expect(
      adaptWebIqResponseV1(
        new Response("{", { status: 200 }),
        {
          query: "query",
          maxResults: 5,
        },
        0,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid-response" }));
    await expect(
      adaptWebIqResponseV1(
        Response.json({ webResults: [{ content: "x".repeat(WEBIQ_RESPONSE_BODY_MAX_BYTES) }] }),
        { query: "query", maxResults: 5 },
        0,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "response-limit-exceeded" }));
  });
});
