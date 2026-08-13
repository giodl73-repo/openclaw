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

The EVID-020 lane keeps the Gateway authoritative for one absolute invocation
deadline. Rust observes the request and its correlated `node.invoke.cancel`;
the caller receives the Gateway-owned `TIMEOUT`, Rust's later result is
explicitly ignored, and one fresh request succeeds through a distinct Rust
process and connection. This proves hard-deadline cancellation signaling and
late-result fencing, not arbitrary caller abort or cooperative interruption of
effects.

The EVID-021 lane uses the production in-process streaming registry seam. Rust
sends progress sequences `1` then `0`; the Gateway delivers `0` then `1`,
settles the stream after its idle window, and emits a correlated cancel. Rust's
later progress and result are both explicitly ignored before a fresh process
settles one distinct request. This proves ordering, inactivity ownership, and
late-frame fencing for side-effect-free evidence, not cooperative interruption
of effects or a new public streaming API.

The EVID-022 lane uses the same production registry's existing ordered input
seam. The Gateway rejects one oversized input before sequence assignment,
sends two bounded frames as sequences `0` and `1`, and refuses further input
after terminal settlement. Rust returns the received JSON only as
side-effect-free evidence. This proves bounded Gateway-to-Rust input transport,
not terminal semantics, a new public streaming API, or Rust authority.

The EVID-023 lane builds one exact Rust artifact, records its SHA-256 digest,
copies it into a fresh candidate install, verifies its declared
`rust-gateway-side-effect-free-v1` profile, and binds a successful live
`system.which` probe to that digest, profile, protocol, connection generation,
and pairing generation. A one-byte mutation is rejected before process launch
or Gateway connection. This proves readiness only for the exact
side-effect-free profile and artifact. It does not prove general runtime
readiness, effects, durable Rust-owned state, Rust authority, production
routing, release promotion, rollback, or TypeScript deletion.

The EVID-024 lane adds a fork-only evidence selector around the existing
generation-fenced dispatch proof. For one declared deployment unit and
selection generation, exactly one eligible Rust candidate invokes the EVID-023
artifact-bound live proof while the TypeScript baseline dispatcher remains
untouched. If both TypeScript and Rust claim the same unit, selection fails
before either dispatcher runs. This proves deterministic single dispatch for
the bounded side-effect-free evidence profile only. It does not add production
routing, transfer effect authority, prove a general canary controller, or make
Rust authoritative.

The EVID-025 lane atomically persists the EVID-024 selection in an
integrity-bound receipt. Distinct fresh processes reload it: the current
selection generation invokes only the selected Rust artifact-bound proof, while
a stale expected generation fails before either TypeScript or Rust dispatch.
This proves restart-portable selection and stale-generation refusal only for
the bounded side-effect-free evidence profile. It does not add a production
selection store, production routing, effect authority, migration, rollback, or
Rust authority.

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
corepack pnpm lobster:rust-gateway-deadline-cancellation
corepack pnpm lobster:rust-gateway-stream-idle-timeout
corepack pnpm lobster:rust-gateway-stream-input
corepack pnpm lobster:rust-gateway-artifact-readiness
corepack pnpm lobster:rust-gateway-single-authority
corepack pnpm lobster:rust-gateway-durable-selection
```

The first successful Gateway connection can spend several minutes compiling
the lazy server path in a fresh checkout. The test keeps that lane bounded to
ten minutes and retains the normal E2E timeout for the refusal lane.
