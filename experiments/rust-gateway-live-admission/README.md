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

The EVID-018 lane starts a real Gateway child process and Rust worker, executes
the approved `system.which` surface, stops both processes, and starts fresh
processes against the same durable Gateway state and persisted Rust
identity and owner-issued node token. It proves the pairing generation survives
and no renewed capability approval is required; it does not prove runtime
readiness, Rust-owned durable state, effects, or authority.

The EVID-019 lane kills the Gateway and a delayed Rust worker after dispatch.
After restart, a fresh authenticated Rust process submits the old request ID
and proves the new Gateway explicitly ignores it because ordinary invocation
state is process-local. The interrupted caller observes transport loss, and
another fresh Rust process then settles exactly one new
`system.which` request without renewed capability approval. This proves
unclean-restart fencing, not durable invocation recovery or exactly-once
effects.

The integration test owns temporary credentials and state. The executable
never emits its private key or device token.

Run the proof from the repository root with Node 24.15.0 or newer in the
supported Node 24 range:

```text
corepack pnpm lobster:rust-gateway-live-admission
corepack pnpm lobster:rust-gateway-side-effect-free-invocation
corepack pnpm lobster:rust-gateway-reconnect-continuity
corepack pnpm lobster:rust-gateway-cold-restart-continuity
corepack pnpm lobster:rust-gateway-unclean-restart-fencing
```

The first successful Gateway connection can spend several minutes compiling
the lazy server path in a fresh checkout. The test keeps that lane bounded to
ten minutes and retains the normal E2E timeout for the refusal lane.
