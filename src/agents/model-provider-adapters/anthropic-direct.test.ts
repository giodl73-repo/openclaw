import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";
import {
  ANTHROPIC_API_KEY_SLOT_ID,
  ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION,
  ANTHROPIC_DIRECT_ORIGIN,
  ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES,
  prepareAnthropicDirectRequestV1,
  type AnthropicDirectAdapterConfigV1,
  type AnthropicDirectRequestContextV1,
} from "./anthropic-direct.js";

type Fixture = {
  request: {
    config: AnthropicDirectAdapterConfigV1;
    context: AnthropicDirectRequestContextV1;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  expected: {
    url: string;
    credentialSlotRefs: string[];
    rewrittenAttachmentMessages: number;
    responsePolicy: {
      mode: "anthropic-messages";
      streaming: boolean;
    };
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/anthropic-direct-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function credentialSlot(
  overrides: Partial<CredentialSlotReadinessV1> = {},
): CredentialSlotReadinessV1 {
  return {
    slotId: ANTHROPIC_API_KEY_SLOT_ID,
    resolverId: "local/anthropic-key",
    version: CREDENTIAL_SLOT_VERSION,
    resolverVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
    placement: "header",
    headerName: "x-api-key",
    allowedOrigins: [ANTHROPIC_DIRECT_ORIGIN],
    required: true,
    ...overrides,
  };
}

function prepare(
  overrides: {
    config?: AnthropicDirectAdapterConfigV1;
    context?: AnthropicDirectRequestContextV1;
    method?: string;
    headers?: HeadersInit;
    body?: string | Uint8Array;
    credentialSlots?: CredentialSlotReadinessV1[];
  } = {},
) {
  return prepareAnthropicDirectRequestV1({
    config: overrides.config ?? fixture.request.config,
    context: overrides.context ?? fixture.request.context,
    method: overrides.method ?? fixture.request.method,
    headers: overrides.headers ?? fixture.request.headers,
    body: overrides.body ?? JSON.stringify(fixture.request.body),
    credentialSlots: overrides.credentialSlots ?? [credentialSlot()],
  });
}

describe("Anthropic direct model-provider adapter", () => {
  it("rewrites the recorded attachment fixture without materializing credentials", () => {
    const prepared = prepare({
      headers: {
        ...fixture.request.headers,
        authorization: "Bearer spoofed",
        "content-length": "1",
        host: "spoofed.example.test",
        "proxy-authorization": "Basic spoofed",
        "transfer-encoding": "chunked",
        "api-key": "spoofed",
      },
    });
    const body = JSON.parse(new TextDecoder().decode(prepared.body));
    const content = body.messages[0].content;

    expect(prepared.url).toBe(fixture.expected.url);
    expect(prepared.adapterVersion).toBe(ANTHROPIC_DIRECT_MODEL_ADAPTER_VERSION);
    expect(prepared.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(prepared.rewrittenAttachmentMessages).toBe(fixture.expected.rewrittenAttachmentMessages);
    expect(prepared.responsePolicy).toEqual(fixture.expected.responsePolicy);
    expect(prepared.headers.get("x-api-key")).toBeNull();
    expect(prepared.headers.get("api-key")).toBeNull();
    expect(prepared.headers.get("authorization")).toBeNull();
    expect(prepared.headers.get("content-length")).toBeNull();
    expect(prepared.headers.get("host")).toBeNull();
    expect(prepared.headers.get("proxy-authorization")).toBeNull();
    expect(prepared.headers.get("transfer-encoding")).toBeNull();
    expect(prepared.headers.get("anthropic-beta")).toBe(fixture.request.headers["anthropic-beta"]);
    expect(content[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "cGRm",
      },
    });
    expect(content).toContainEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "aW1hZ2U=",
      },
    });
    expect(content.at(-1)).toEqual({
      type: "text",
      text: " and summarize ",
      cache_control: { type: "ephemeral" },
    });
  });

  it("preserves final JSON bytes, fallback parameters, and Anthropic streaming headers", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      stream: true,
      service_tier: "auto",
      speed: "fast",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    const prepared = prepare({
      body,
      headers: {
        accept: "text/event-stream",
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      },
    });

    expect(new TextDecoder().decode(prepared.body)).toBe(body);
    expect(prepared.headers.get("accept")).toBe("text/event-stream");
    expect(prepared.headers.get("anthropic-beta")).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(prepared.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(prepared.responsePolicy.streaming).toBe(true);
  });

  it("preserves malformed markers and non-user content as text", () => {
    const prepared = prepare({
      body: JSON.stringify({
        stream: false,
        messages: [
          {
            role: "assistant",
            content: '<lobster-image data="data:image/png;base64,aW1hZ2U=" />',
          },
          {
            role: "user",
            content: '<lobster-image data="data:image/png;base64,not-base64" />',
          },
        ],
      }),
    });
    const body = JSON.parse(new TextDecoder().decode(prepared.body));

    expect(body.messages[0].content).toBe(
      '<lobster-image data="data:image/png;base64,aW1hZ2U=" />',
    );
    expect(body.messages[1].content).toEqual([
      {
        type: "text",
        text: '<lobster-image data="data:image/png;base64,not-base64" />',
      },
    ]);
    expect(prepared.rewrittenAttachmentMessages).toBe(1);
  });

  it("fails closed on missing or incompatible credential slots", () => {
    expect(() => prepare({ credentialSlots: [] })).toThrowError(
      expect.objectContaining({ code: "missing-credential-slot" }),
    );
    expect(() =>
      prepare({ credentialSlots: [credentialSlot({ headerName: "authorization" })] }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    expect(() => prepare({ credentialSlots: [credentialSlot(), credentialSlot()] })).toThrowError(
      expect.objectContaining({ code: "missing-credential-slot" }),
    );
    expect(() => prepare({ credentialSlots: [credentialSlot({ required: false })] })).toThrowError(
      expect.objectContaining({ code: "incompatible-credential-slot" }),
    );
    expect(() =>
      prepare({
        credentialSlots: [credentialSlot({ allowedOrigins: ["https://other.example.test"] })],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
  });

  it("rejects alternate origins, paths, methods, malformed JSON, and oversized bodies", () => {
    expect(() =>
      prepare({
        context: { originalUrl: "https://proxy.example.test/v1/messages" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        config: { endpoint: "https://api.anthropic.com/v1/models" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() =>
      prepare({
        context: {
          originalUrl: "https://api.anthropic.com/v1/messages?api-version=other",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
    expect(() => prepare({ method: "GET" })).toThrowError(
      expect.objectContaining({ code: "invalid-request" }),
    );
    expect(() => prepare({ body: "{" })).toThrowError(
      expect.objectContaining({ code: "invalid-body" }),
    );
    expect(() =>
      prepare({ body: new Uint8Array(ANTHROPIC_DIRECT_REQUEST_BODY_MAX_BYTES + 1) }),
    ).toThrowError(expect.objectContaining({ code: "body-limit-exceeded" }));
  });

  it("rejects one-shot bodies instead of buffering them implicitly", () => {
    const oneShotBody = new ReadableStream<Uint8Array>() as unknown as string;

    expect(() => prepare({ body: oneShotBody })).toThrowError(
      expect.objectContaining({ code: "invalid-body" }),
    );
  });
});
