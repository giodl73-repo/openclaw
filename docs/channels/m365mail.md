---
summary: "Run an OpenClaw agent through a brokered Microsoft 365 mailbox"
read_when:
  - You are configuring the hosted Microsoft 365 email channel
  - You are debugging inbound email or Microsoft Graph replies
title: "Microsoft 365 Email"
---

Microsoft 365 Email connects a hosted OpenClaw agent to its provisioned mailbox. The external host delivers inbound email activities to the Gateway. OpenClaw owns message parsing, sender policy, threading, Graph request bytes, and response handling; it does not acquire or store the Graph token.

This channel is for deployments using an external host plugin. A standalone OpenClaw installation does not provision the mailbox, inbound activity route, or `m365mail/graph-token` credential slot.

The owner-controlled hosted Graph binding is defined but inactive in this release slice. External host activation is a separate adoption step; until then, the live channel preserves its existing brokered egress path with the same owner-prepared request.

## Requirements

- A host-provisioned Microsoft 365 agent identity and mailbox
- The `m365mail` bundled plugin enabled in the hosted OpenClaw build
- `OPENCLAW_M365MAIL_AGENT_ID` set to the trusted Entra object ID or UPN for the provisioned mailbox
- External host inbound activity delivery and brokered Graph egress configured for the container
- The external host forwarder configured with Gateway authentication for the webhook request

## Enable the channel

The external host normally projects the required environment variables when it starts the container. Enable the channel in `openclaw.json`:

```json5
{
  channels: {
    m365mail: {
      enabled: true,
    },
  },
}
```

The default webhook path is `/webhook/m365mail`. The default Graph base URL is `https://graph.microsoft.com/v1.0`.

Do not configure a Graph bearer token in OpenClaw. When the hosted binding is activated, it resolves the exact `m365mail/graph-token` credential slot and places it in the Authorization header after the owner has prepared the request.

## Restrict inbound senders

The channel accepts senders by default. To require an allowlist:

```json5
{
  channels: {
    m365mail: {
      enabled: true,
      dmPolicy: "allowlist",
      allowedSenders: ["ada@contoso.com", "grace@contoso.com"],
    },
  },
}
```

With `dmPolicy: "allowlist"`, an empty `allowedSenders` list blocks the route from starting.

Cross-tenant and tenant-less senders are rejected by default when the owner tenant is known. Set `allowCrossTenant: true` only when the mailbox must accept external senders.

## Configure the hosted environment

The external host can project these variables:

| Variable                      | Purpose                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `OPENCLAW_M365MAIL_AGENT_ID`  | Trusted mailbox identity used in `/users/{id}` Graph paths            |
| `M365MAIL_AUTH`               | Legacy container marker used to discover the default brokered account |
| `M365MAIL_GRAPH_BASE_URL`     | Graph API base URL for the configured Microsoft cloud                 |
| `M365MAIL_WEBHOOK_PATH`       | Loopback path for inbound email activities                            |
| `M365MAIL_ALLOWED_SENDERS`    | Comma-separated sender allowlist                                      |
| `M365MAIL_ALLOW_CROSS_TENANT` | Allows external senders when set to `true`                            |
| `M365MAIL_RATE_LIMIT`         | Maximum accepted inbound messages per minute                          |
| `OPENCLAW_BOT_NAME`           | Display name used in generated replies                                |

Only the Microsoft Graph global, US Government, US Government DoD, and China production origins are accepted. Invalid or non-HTTPS Graph base URLs fall back to the global production endpoint.

## Mailbox identity and replies

The configured `OPENCLAW_M365MAIL_AGENT_ID` is authoritative. An inbound activity may attest to that identity, but it cannot select a different mailbox. A mismatch fails before dispatch.

Brokered inbound notifications must include a Graph message ID so OpenClaw can suppress duplicate delivery. Replies use that ID with the Graph reply endpoint. Proactive outbound mail uses `sendMail`.

Graph mail operations succeed only on `202 Accepted`. OpenClaw never automatically replays a Graph mail request after a timeout, disconnect, or server error because the service may have accepted the message before the failure became observable. A `429` response can expose bounded `Retry-After` guidance for an explicit operator-controlled retry.

## Troubleshooting

### The channel reports a missing mailbox identity

Confirm that the external host projected a non-empty `OPENCLAW_M365MAIL_AGENT_ID`. Do not substitute the recipient identity from an inbound activity.

### An inbound sender is rejected

Check `dmPolicy`, `allowedSenders`, and the sender tenant. External or tenant-less senders require `allowCrossTenant: true`.

### A reply fails before reaching Graph

Confirm that the hosted binding selected the `m365mail/graph-token` slot, the configured Graph URL uses an allowed production origin, and the inbound recipient identity matches the configured mailbox identity.

### Graph accepted the request but delivery is unclear

A `202` response confirms Graph accepted the operation; it does not confirm final delivery. Do not replay the request automatically. Use Microsoft 365 message tracing or mailbox diagnostics to determine the final state.

## Related

- [Chat channels](/channels/index)
- [Microsoft Teams](/channels/msteams)
- [Plugins](/tools/plugin)
