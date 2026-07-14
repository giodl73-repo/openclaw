import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SLOT_RESOLVER_VERSION,
  CREDENTIAL_SLOT_VERSION,
  type CredentialSlotReadinessV1,
} from "../../infra/net/credential-slot.js";
import {
  CAPI_BEARER_SLOT_ID,
  CAPI_MODEL_ADAPTER_VERSION,
  CAPI_REQUEST_BODY_MAX_BYTES,
  adaptCapiModelResponseV1,
  prepareCapiModelRequestV1,
  type CapiModelAdapterConfigV1,
  type CapiModelRequestContextV1,
} from "./capi.js";

type Fixture = {
  request: {
    config: CapiModelAdapterConfigV1;
    context: CapiModelRequestContextV1;
    method: string;
    body: string;
  };
  expected: {
    url: string;
    credentialSlotRefs: string[];
    headers: Record<string, string>;
  };
  sse: {
    input: string;
    expected: string;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/capi-model-adapter-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function credentialSlot(
  overrides: Partial<CredentialSlotReadinessV1> = {},
): CredentialSlotReadinessV1 {
  return {
    slotId: CAPI_BEARER_SLOT_ID,
    resolverId: "local/capi-token",
    version: CREDENTIAL_SLOT_VERSION,
    resolverVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
    placement: "header",
    headerName: "authorization",
    allowedOrigins: ["https://capi.example.com"],
    required: true,
    ...overrides,
  };
}

function prepare(
  overrides: {
    config?: CapiModelAdapterConfigV1;
    context?: CapiModelRequestContextV1;
    body?: string | Uint8Array;
    credentialSlots?: CredentialSlotReadinessV1[];
  } = {},
) {
  return prepareCapiModelRequestV1({
    config: overrides.config ?? fixture.request.config,
    context: overrides.context ?? fixture.request.context,
    method: fixture.request.method,
    body: overrides.body ?? fixture.request.body,
    credentialSlots: overrides.credentialSlots ?? [credentialSlot()],
  });
}

async function responseText(response: Response): Promise<string> {
  return await response.text();
}

describe("CAPI model-provider adapter", () => {
  it("matches the recorded request fixture without materializing credentials", () => {
    const prepared = prepare();

    expect(prepared.url).toBe(fixture.expected.url);
    expect(prepared.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(prepared.adapterVersion).toBe(CAPI_MODEL_ADAPTER_VERSION);
    expect(prepared.model).toBe("claude-opus-4-6");
    expect(prepared.stream).toBe(true);
    for (const [name, value] of Object.entries(fixture.expected.headers)) {
      expect(prepared.headers.get(name)).toBe(value);
    }
    expect(prepared.headers.get("authorization")).toBeNull();
    expect(new TextDecoder().decode(prepared.body)).toBe(fixture.request.body);
  });

  it("forwards only owner-approved semantic headers", () => {
    const prepared = prepareCapiModelRequestV1({
      config: fixture.request.config,
      context: fixture.request.context,
      method: fixture.request.method,
      headers: {
        accept: "application/json",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "anthropic-version": "2023-06-01",
        authorization: "******",
        "content-type": "application/json",
        "x-api-key": "******",
        "x-untrusted-forwarded-header": "do-not-forward",
      },
      body: fixture.request.body,
      credentialSlots: [credentialSlot()],
    });

    expect(Object.fromEntries(prepared.headers)).toMatchObject({
      accept: "application/json",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(prepared.headers.get("authorization")).toBeNull();
    expect(prepared.headers.get("x-api-key")).toBeNull();
    expect(prepared.headers.get("x-untrusted-forwarded-header")).toBeNull();
  });

  it("fails before dispatch when the bearer slot is missing or incompatible", () => {
    expect(() => prepare({ credentialSlots: [] })).toThrowError(
      expect.objectContaining({ code: "missing-credential-slot" }),
    );
    expect(() =>
      prepare({
        credentialSlots: [credentialSlot({ headerName: "x-api-key" })],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    expect(() =>
      prepare({
        credentialSlots: [credentialSlot({ allowedOrigins: ["https://other.example.com"] })],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
  });

  it("rejects unsafe model interpolation and invalid tenant context", () => {
    expect(() =>
      prepare({ body: JSON.stringify({ model: "../../admin", stream: true }) }),
    ).toThrowError(expect.objectContaining({ code: "invalid-model" }));
    expect(() =>
      prepare({
        context: { ...fixture.request.context, tenantId: "not-a-uuid" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-context" }));
  });

  it("rejects incompatible slot versions, broader origins, and non-POST requests", () => {
    expect(() =>
      prepare({
        credentialSlots: [
          credentialSlot({
            version: "credential-slot/v1" as never,
            resolverVersion: "credential-slot-resolver/v2" as never,
          }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    expect(() =>
      prepare({
        credentialSlots: [
          credentialSlot({
            allowedOrigins: ["https://capi.example.com", "https://other.example.com"],
          }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-credential-slot" }));
    expect(() =>
      prepareCapiModelRequestV1({
        config: fixture.request.config,
        context: fixture.request.context,
        method: "GET",
        body: fixture.request.body,
        credentialSlots: [credentialSlot()],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-request" }));
  });

  it("enforces a bounded request body before parsing", () => {
    expect(() => prepare({ body: new Uint8Array(CAPI_REQUEST_BODY_MAX_BYTES + 1) })).toThrowError(
      expect.objectContaining({ code: "body-limit-exceeded" }),
    );
  });

  it("requires HTTPS before declaring the bearer credential slot", () => {
    expect(() =>
      prepare({
        config: {
          ...fixture.request.config,
          endpointTemplate:
            "http://capi.example.com/v0/resourceproxy/tenantId.{tenant_id}/anthropic/llm/{model}/messages",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
  });

  it("matches the recorded SSE fixture and drops the CAPI done sentinel", async () => {
    const prepared = prepare();
    const response = new Response(fixture.sse.input, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const adapted = adaptCapiModelResponseV1(response, prepared.responsePolicy);

    await expect(responseText(adapted)).resolves.toBe(fixture.sse.expected);
  });

  it("preserves existing event lines and non-success responses", async () => {
    const existing = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const adapted = adaptCapiModelResponseV1(new Response(existing, { status: 200 }), {
      injectAnthropicSseEventTypes: true,
    });
    await expect(responseText(adapted)).resolves.toBe(existing);

    const failed = new Response(fixture.sse.input, { status: 500 });
    expect(adaptCapiModelResponseV1(failed, { injectAnthropicSseEventTypes: true })).toBe(failed);
  });

  it("handles CR-only event boundaries and removes stale content length", async () => {
    const input = 'data: {"type":"message_start"}\r\r';
    const response = new Response(input, {
      status: 200,
      headers: { "content-length": String(input.length) },
    });

    const adapted = adaptCapiModelResponseV1(response, {
      injectAnthropicSseEventTypes: true,
    });

    expect(adapted.headers.get("content-length")).toBeNull();
    await expect(responseText(adapted)).resolves.toBe(
      'event: message_start\ndata: {"type":"message_start"}\r\r',
    );
  });

  it("keeps events separate when adjacent lines use mixed endings", async () => {
    const input = 'data: {"type":"message_start"}\r\n\ndata: {"type":"content_block_start"}\n\r';

    const adapted = adaptCapiModelResponseV1(new Response(input, { status: 200 }), {
      injectAnthropicSseEventTypes: true,
    });

    await expect(responseText(adapted)).resolves.toBe(
      'event: message_start\r\ndata: {"type":"message_start"}\r\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start"}\n\r',
    );
  });

  it("resumes event injection after passing through an oversized event", async () => {
    const oversized = `data: ${"x".repeat(1024 * 1024)}`;
    const next = 'data: {"type":"message_start"}\n\n';
    const adapted = adaptCapiModelResponseV1(new Response(`${oversized}\n\n${next}`), {
      injectAnthropicSseEventTypes: true,
    });

    const output = await responseText(adapted);

    expect(output.startsWith(`${oversized}\n\n`)).toBe(true);
    expect(output.endsWith(`event: message_start\n${next}`)).toBe(true);
  });

  it("preserves UTF-8 payloads split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode('data: {"type":"content_block_delta","text":"🦞"}\n\n');
    const emojiStart = payload.findIndex((byte) => byte === 0xf0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, emojiStart + 2));
        controller.enqueue(payload.slice(emojiStart + 2));
        controller.close();
      },
    });

    const adapted = adaptCapiModelResponseV1(new Response(body, { status: 200 }), {
      injectAnthropicSseEventTypes: true,
    });

    await expect(responseText(adapted)).resolves.toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","text":"🦞"}\n\n',
    );
  });

  it("skips invalid optional identity headers instead of emitting malformed values", () => {
    const prepared = prepareCapiModelRequestV1({
      config: fixture.request.config,
      context: {
        ...fixture.request.context,
        userId: "bad\r\nvalue",
        correlationId: "",
      },
      method: fixture.request.method,
      headers: {
        "x-ms-client-principal-id": "spoofed-user",
        "x-ms-correlation-id": "spoofed-correlation",
      },
      body: fixture.request.body,
      credentialSlots: [credentialSlot()],
    });

    expect(prepared.headers.get("x-ms-client-principal-id")).toBeNull();
    expect(prepared.headers.get("x-ms-correlation-id")).toBeNull();
    expect(prepared.headers.get("x-ms-client-tenant-id")).toBe(fixture.request.context.tenantId);
  });
});
