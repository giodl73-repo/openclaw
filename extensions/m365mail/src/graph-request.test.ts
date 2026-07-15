import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acceptM365MailGraphResponseV1,
  M365MAIL_GRAPH_ALLOWED_ORIGINS,
  M365MAIL_GRAPH_BEARER_SLOT_ID,
  prepareM365MailGraphRequestV1,
  type M365MailGraphCredentialSlotReadinessV1,
  type M365MailGraphRequestContextV1,
  type M365MailGraphOperationV1,
} from "./graph-request.js";

type Fixture = {
  request: {
    context: M365MailGraphRequestContextV1;
    operation: M365MailGraphOperationV1;
  };
  expected: {
    url: string;
    method: string;
    body: string;
    credentialSlotRefs: string[];
    responsePolicy: {
      mode: string;
      successStatus: number;
      replay: string;
    };
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/m365mail-graph-request-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function slots(
  overrides: Partial<M365MailGraphCredentialSlotReadinessV1> = {},
): M365MailGraphCredentialSlotReadinessV1[] {
  return [
    {
      slotId: M365MAIL_GRAPH_BEARER_SLOT_ID,
      resolverId: "test/graph-token",
      version: "credential-slot/v1",
      resolverVersion: "credential-slot-resolver/v1",
      placement: "header",
      headerName: "authorization",
      allowedOrigins: [...M365MAIL_GRAPH_ALLOWED_ORIGINS],
      required: true,
      ...overrides,
    },
  ];
}

describe("Microsoft 365 Email Graph owner", () => {
  it("prepares identical owner bytes for local and hosted transport", () => {
    const local = prepareM365MailGraphRequestV1(fixture.request);
    const hosted = prepareM365MailGraphRequestV1({
      ...fixture.request,
      credentialSlots: slots(),
    });

    expect(hosted.url).toBe(fixture.expected.url);
    expect(hosted.method).toBe(fixture.expected.method);
    expect(new TextDecoder().decode(hosted.body)).toBe(fixture.expected.body);
    expect(hosted.credentialSlotRefs).toEqual(fixture.expected.credentialSlotRefs);
    expect(hosted.responsePolicy).toEqual(fixture.expected.responsePolicy);
    expect(local.url).toBe(hosted.url);
    expect(local.method).toBe(hosted.method);
    expect(new TextDecoder().decode(local.body)).toBe(new TextDecoder().decode(hosted.body));
    expect(local.credentialSlotRefs).toEqual([]);
  });

  it("fails before dispatch on missing or mismatched trusted mailbox identity", () => {
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        context: {
          ...fixture.request.context,
          account: { ...fixture.request.context.account, agentId: "" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "identity-missing" }));
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        context: { ...fixture.request.context, agentId: "other-agent" },
      }),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));
  });

  it("matches UPN mailbox identity case-insensitively", () => {
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        context: {
          ...fixture.request.context,
          account: { ...fixture.request.context.account, agentId: "Agent@Owner.Example" },
          agentId: "agent@owner.example",
        },
      }),
    ).not.toThrow();
  });

  it("rejects origin, credential, and header widening", () => {
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        context: {
          ...fixture.request.context,
          account: {
            ...fixture.request.context.account,
            graphBaseUrl: "https://evil.example.test/v1.0",
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "target-denied" }));
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        credentialSlots: slots({ allowedOrigins: ["https://graph.microsoft.com"] }),
      }),
    ).toThrowError(expect.objectContaining({ code: "credential-slot-incompatible" }));
    expect(() =>
      prepareM365MailGraphRequestV1({
        ...fixture.request,
        headers: { authorization: "caller-token" },
      }),
    ).toThrowError(expect.objectContaining({ code: "credential-conflict" }));

    const prepared = prepareM365MailGraphRequestV1({
      ...fixture.request,
      headers: {
        accept: "application/json",
        cookie: "session=spoofed",
        "x-api-key": "spoofed",
      },
    });
    expect(prepared.headers.get("accept")).toBe("application/json");
    expect(prepared.headers.get("cookie")).toBeNull();
    expect(prepared.headers.get("x-api-key")).toBeNull();
  });

  it("accepts only 202 and surfaces bounded throttling advice without replaying", async () => {
    const prepared = prepareM365MailGraphRequestV1(fixture.request);
    await expect(
      acceptM365MailGraphResponseV1(new Response(null, { status: 202 }), prepared.responsePolicy),
    ).resolves.toBeUndefined();
    await expect(
      acceptM365MailGraphResponseV1(new Response(null, { status: 200 }), prepared.responsePolicy),
    ).rejects.toMatchObject({ code: "response-rejected", status: 200 });
    await expect(
      acceptM365MailGraphResponseV1(
        new Response(null, { status: 429, headers: { "retry-after": "900" } }),
        prepared.responsePolicy,
      ),
    ).rejects.toMatchObject({
      code: "throttled",
      status: 429,
      retryAfterMs: 300_000,
    });
  });
});
