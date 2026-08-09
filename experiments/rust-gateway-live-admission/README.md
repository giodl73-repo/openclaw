# Rust Gateway Live Admission

This fork-only experiment proves that a clean-built Rust process can cross the
current OpenClaw Gateway's real node handshake boundary.

It uses an ephemeral Ed25519 identity, an owner-issued node device token, the
Gateway's v3 challenge signature, and a real loopback WebSocket. It declares no
commands and executes no invocation. A successful `hello-ok` proves live
authenticated admission only; it does not prove readiness, runtime authority,
state migration, release promotion, rollback, or TypeScript deletion.

The separate EVID-016 lane reuses this authenticated client in `serve-one`
mode. It advertises the signed host platform and device family, waits for
operator approval of exactly `system.which`, and settles one correlated
`node.invoke.request` through `node.invoke.result`. Gateway command policy
refuses an undeclared `system.notify` before Rust receives it. This remains a
side-effect-free evidence slice, not a general node runtime.

The integration test owns temporary credentials and state. The executable
never emits its private key or device token.

Run the proof from the repository root with Node 24.15.0 or newer in the
supported Node 24 range:

```text
corepack pnpm lobster:rust-gateway-live-admission
corepack pnpm lobster:rust-gateway-side-effect-free-invocation
```

The first successful Gateway connection can spend several minutes compiling
the lazy server path in a fresh checkout. The test keeps that lane bounded to
ten minutes and retains the normal E2E timeout for the refusal lane.
