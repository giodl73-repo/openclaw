import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";
import {
  SUBSTRATE_BEARER_SLOT_ID,
  SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION,
  SUBSTRATE_REQUEST_BODY_MAX_BYTES,
  prepareSubstrateLlmApiRequestV1,
  type SubstrateLlmApiAdapterConfigV1,
  type SubstrateLlmApiRequestContextV1,
} from "./substrate-llmapi.js";

type Fixture = {
  request: {
    config: SubstrateLlmApiAdapterConfigV1;
    context: SubstrateLlmApiRequestContextV1;
    method: string;
    body: string;
  };
  expected: {
    url: string;
    credentialSlotRefs: string[];
    modelType: string;
    headers: Record<string, string>;
    extendedProperties: Record<string, string>;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/substrate-llmapi-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function credentialSlot(
  overrides: Partial<CredentialSlotReadinessV1> = {},
): CredentialSlotReadinessV1 {
  return {
    slotId: SUBSTRATE_BEARER_SLOT_ID,
    resolverId: "local/substrate-token",
    version: CREDENTIAL_SLOT_VERSION,
    resolverVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
    placement: "header",
    headerName: "authorization",
    allowedOrigins: ["https://substrate.example.com"],
    required: true,
    ...overrides,
  };
}

function prepare(
  overrides: {
    config?: SubstrateLlmApiAdapterConfigV1;
    context?: SubstrateLlmApiRequestContextV1;
    method?: string;
    headers?: HeadersInit;
    body?: string | Uint8Array;
    credentialSlots?: CredentialSlotReadinessV1[];
  } = {},
) {
  return prepareSubstrateLlmApiRequestV1({
    config: overrides.config ?? fixture.request.config,
    context: overrides.context ?? fixture.request.context,
    method: overrides.method ?? fixture.request.method,
    ...(overrides.headers ? { headers: overrides.headers } : {}),
    body: overrides.body ?? fixture.request.body,
    credentialSlots: overrides.credentialSlots ?? [credentialSlot()],
  });
}

describe("Substrate LLM API model-provider adapter", () => {
  it("matches the recorded request fixture without materializing credentials", () => {
    const prepared = prepare({
      headers: {
        authorization: "spoofed",
        "x-api-key": "spoofed",
        cookie: "session=spoofed",
        "x-client-header": "spoofed",
      },
    });

    expect(prepared.url).toBe(fixture.expected.url);
    expect(prepared.adapterVersion).toBe(SUBSTRATE_LLMAPI_MODEL_ADAPTER_VERSION);
    expect(prepared.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(prepared.modelType).toBe(fixture.expected.modelType);
    expect(prepared.headers.get("authorization")).toBeNull();
    expect(prepared.headers.get("x-api-key")).toBeNull();
    expect(prepared.headers.get("cookie")).toBeNull();
    expect(prepared.headers.get("x-client-header")).toBeNull();
    for (const [name, value] of Object.entries(fixture.expected.headers)) {
      expect(prepared.headers.get(name)).toBe(value);
    }
    expect(JSON.parse(prepared.headers.get("x-taxonomy-extendedproperties") ?? "{}")).toEqual(
      fixture.expected.extendedProperties,
    );
    expect(new TextDecoder().decode(prepared.body)).toBe(fixture.request.body);
  });

  it("preserves the original path and query when no fixed model path is configured", () => {
    const prepared = prepare({
      config: { ...fixture.request.config, modelPath: undefined },
      context: {
        ...fixture.request.context,
        originalUrl: "https://api.openai.com/v1/chat/completions?api-version=1",
      },
    });

    expect(prepared.url).toBe("https://substrate.example.com/v1/chat/completions?api-version=1");
  });

  it("does not resolve inherited model-map properties", () => {
    const prepared = prepare({
      body: JSON.stringify({ model: "constructor", messages: [] }),
    });

    expect(prepared.modelType).toBe("constructor");
  });

  it("uses safe raw and configured default model types", () => {
    expect(
      prepare({ body: '{"model":"prod-anthropic-claude-opus-4-6","messages":[]}' }).modelType,
    ).toBe("prod-anthropic-claude-opus-4-6");
    expect(
      prepare({
        config: { ...fixture.request.config, defaultModelType: "dev-gpt-56-reasoning" },
        body: '{"messages":[]}',
      }).modelType,
    ).toBe("dev-gpt-56-reasoning");
  });

  it("fails before dispatch when the bearer slot is missing or incompatible", () => {
    expect(() => prepare({ credentialSlots: [] })).toThrowError(
      expect.objectContaining({ code: "missing-credential-slot" }),
    );
    expect(() =>
      prepare({ credentialSlots: [credentialSlot({ headerName: "x-api-key" })] }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    expect(() =>
      prepare({
        credentialSlots: [credentialSlot({ allowedOrigins: ["https://other.example.com"] })],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
  });

  it("rejects unsafe models, malformed JSON, non-POST requests, and oversized bodies", () => {
    expect(() => prepare({ body: '{"model":"../../admin"}' })).toThrowError(
      expect.objectContaining({ code: "invalid-model" }),
    );
    expect(() => prepare({ body: "{" })).toThrowError(
      expect.objectContaining({ code: "invalid-body" }),
    );
    expect(() => prepare({ method: "GET" })).toThrowError(
      expect.objectContaining({ code: "invalid-request" }),
    );
    expect(() =>
      prepare({ body: new Uint8Array(SUBSTRATE_REQUEST_BODY_MAX_BYTES + 1) }),
    ).toThrowError(expect.objectContaining({ code: "body-limit-exceeded" }));
  });

  it("requires HTTPS endpoint config and valid owner-controlled header values", () => {
    expect(() =>
      prepare({
        config: { ...fixture.request.config, endpoint: "http://substrate.example.com" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        config: { ...fixture.request.config, scenarioGuid: "bad\r\nvalue" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        config: {
          ...fixture.request.config,
          modelMap: { " anthropic/claude-opus-4-6": "dev-gpt-55-chat-example" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        config: {
          ...fixture.request.config,
          modelMap: { "anthropic/claude-opus-4-6": "../../admin" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        config: { ...fixture.request.config, modelPath: "/v1/../admin" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
  });
});
