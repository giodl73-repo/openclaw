import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MSTEAMS_ACF_ALLOWED_ORIGINS,
  MSTEAMS_ACF_BEARER_SLOT_ID,
  adaptMSTeamsAcfChannelResponseV1,
  prepareMSTeamsAcfChannelRequestV1,
  type MSTeamsAcfCredentialSlotReadinessV1,
  type MSTeamsAcfRequestContextV1,
} from "./acf-channel-request.js";

type Fixture = {
  request: {
    context: MSTeamsAcfRequestContextV1;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  expected: {
    credentialSlotRefs: string[];
    responsePolicy: {
      mode: "msteams-acf";
      streaming: false;
    };
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/msteams-acf-channel-request-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function slot(
  overrides: Partial<MSTeamsAcfCredentialSlotReadinessV1> = {},
): MSTeamsAcfCredentialSlotReadinessV1 {
  return {
    slotId: MSTEAMS_ACF_BEARER_SLOT_ID,
    version: "credential-slot/v1",
    resolverVersion: "credential-slot-resolver/v1",
    placement: "header",
    headerName: "authorization",
    allowedOrigins: [...MSTEAMS_ACF_ALLOWED_ORIGINS],
    required: true,
    ...overrides,
  };
}

describe("Microsoft Teams ACF Channel request", () => {
  it("preserves the owner-prepared activity and selects the exact bearer slot", () => {
    const prepared = prepareMSTeamsAcfChannelRequestV1({
      ...fixture.request,
      headers: {
        ...fixture.request.headers,
        "content-length": "stale",
        host: "caller.example.test",
        "transfer-encoding": "chunked",
      },
      credentialSlots: [slot()],
    });

    expect(prepared.url).toBe(fixture.request.url);
    expect(prepared.method).toBe("POST");
    expect(new TextDecoder().decode(prepared.body)).toBe(fixture.request.body);
    expect(prepared.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(prepared.responsePolicy).toEqual(fixture.expected.responsePolicy);
    expect(prepared.headers.get("user-agent")).toBe(fixture.request.headers["user-agent"]);
    expect(prepared.headers.has("authorization")).toBe(false);
    expect(prepared.headers.has("content-length")).toBe(false);
    expect(prepared.headers.has("host")).toBe(false);
    expect(prepared.headers.has("transfer-encoding")).toBe(false);
  });

  it("rejects malformed, oversized, and method-route-incompatible activities", () => {
    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        body: "{",
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "body-invalid" }));

    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        body: new Uint8Array(8 * 1024 * 1024 + 1),
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "body-too-large" }));

    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        url: `${fixture.request.url}/activity-1`,
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "method-unsupported" }));

    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        method: "DELETE",
        body: undefined,
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "method-unsupported" }));
  });

  it("fails before dispatch when required Channel identity is missing or mismatched", () => {
    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        context: { ...fixture.request.context, tenantId: "" },
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "identity-missing" }));

    const mismatched = JSON.stringify({
      ...JSON.parse(fixture.request.body),
      recipient: { id: "29:other-user" },
    });
    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        body: mismatched,
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "identity-mismatch" }));

    const tenantMismatch = JSON.stringify({
      ...JSON.parse(fixture.request.body),
      channelData: { tenant: { id: "6f9619ff-8b86-d011-b42d-00c04fc964ff" } },
    });
    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        body: tenantMismatch,
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "identity-mismatch" }));
  });

  it("rejects credential conflicts, widened slots, and unsupported targets", () => {
    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        headers: { authorization: "******" },
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "credential-conflict" }));

    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        credentialSlots: [
          slot({ allowedOrigins: [...MSTEAMS_ACF_ALLOWED_ORIGINS, "https://other.example.test"] }),
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "credential-slot-incompatible",
      }),
    );

    expect(() =>
      prepareMSTeamsAcfChannelRequestV1({
        ...fixture.request,
        url: "https://smba.trafficmanager.net.evil.example/v3/conversations/c1/activities",
        credentialSlots: [slot()],
      }),
    ).toThrow(expect.objectContaining({ code: "target-denied" }));
  });

  it("supports bodyless activity deletion only on an activity-specific route", () => {
    const prepared = prepareMSTeamsAcfChannelRequestV1({
      context: fixture.request.context,
      method: "DELETE",
      url: `${fixture.request.url}/activity-1`,
      credentialSlots: [slot()],
    });

    expect(prepared.method).toBe("DELETE");
    expect(prepared.body).toBeUndefined();
  });

  it("preserves the raw non-streaming Bot Connector response", () => {
    const response = new Response("connector-response", {
      status: 429,
      headers: { "retry-after": "5" },
    });

    expect(
      adaptMSTeamsAcfChannelResponseV1(response, {
        mode: "msteams-acf",
        streaming: false,
      }),
    ).toBe(response);
  });
});
