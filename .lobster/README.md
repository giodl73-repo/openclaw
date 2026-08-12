# Lobster fork metadata

This directory contains fork-only reconstruction and evidence metadata. It is
not imported by OpenClaw production code and does not change default runtime,
configuration, package, plugin, skill, or CLI behavior.

- `queue.json` pins the upstream base and ordered carried-source admission.
- `sources.json` captures exact upstream pull request generations as quarantined
  inventory with no build, evidence, release, or runtime authority.
- `contracts.json` publishes the executable XPK-001 through XPK-009 Wave 0
  ownership, reference, evidence, mutation, profile, trust-order, fixture, and
  ledger definition gates. They carry definition-only authority: deployment
  profile instances still require concrete budget thresholds before admission.
- `baseline.json` pins cross-platform vanilla-equivalent commands.
- `fixtures.json` reserves stable fixture identities.
- `disposition.json` separates retained metadata from deletion obligations.

EVID-003 adds the fork-only `lobster.mpu.provider-attempt-usage.v1` fixture. It
proves that fallback candidate identity must parent existing model-call facts
before dispatch, while preserving the current run usage accumulator. It adds no
provider, billing, budget, or runtime authority.

EVID-004 adds the fork-only `lobster.dgr.restart-safe-bounded-lease.v1`
fixture. It reuses the host-owned state lease as the capacity-one oracle and
proves exhaustion, restart recovery, lost-acknowledgement identity, stale-holder
fencing, renewal or expiry, and terminal settlement. It does not replace Cron,
worktree, child-admission, scheduling, policy, billing, or fleet owners and
carries authority `none`.

EVID-005 adds the fork-only
`lobster.kcc.mixed-owner-checkpoint-copy-facts.v1` fixture. It proves dirty
checkpoint refusal, compatible clean capture, and truthful per-owner copy
settlement across complete, retained, externally controlled, and unknown
outcomes. It adds no checkpoint implementation, copy database, retention
policy, restore path, or cross-owner mutation authority and carries authority
`none`.

EVID-006 adds the fork-only
`lobster.dgr.immutable-lifecycle-obligations.v1` fixture. It proves immutable
accepted required-child membership, final authority, policy-generation,
owner-generation, and hold fencing before destructive effects, and
lost-acknowledgement reconciliation under one stable child operation identity.
It adds no lifecycle coordinator, policy or legal-hold service, data owner,
workflow database, or mutation authority and carries authority `none`.

EVID-007 adds the fork-only
`lobster.rfn.remote-node-invocation-trust.v1` fixture. It correlates current
pairing generation, connection, command policy, invocation, idempotency,
ordered progress, dispatch, cancellation, and owner-native effect certainty.
It keeps capability advertisement non-authorizing and a post-dispatch local
abort explicitly unknown at the remote effect boundary. It adds no node
runtime, command policy, pairing owner, transport, audit service, or invocation
authority and carries authority `none`.

EVID-008 adds the fork-only
`lobster.exa.authorized-external-action.v1` fixture. It correlates the admitted
requester, run-scoped tool surface, current policy generation, approval,
finalized parameter fingerprint, owner idempotency identity, runtime outcome,
and owner-native effect certainty. It blocks stale policy before dispatch and
resolves an exact replay to the original effect without counting a duplicate.
It adds no action bus, policy or approval owner, generic retry policy, audit
service, external-effect owner, or execution authority and carries authority
`none`.

EVID-009 adds the fork-only `lobster.rla.release-activation.v1` fixture. It
composes existing updater-owner facts to prove one exact compatible candidate
completes ordered package, Doctor, plugin, service, and readiness phases, while
one newer-schema target is refused before package, state, or service mutation.
Release proof stays referenced by immutable identity, readiness stays bound to
the candidate service incarnation, code and state recovery certainty remain
separate, and authority remains `none`.

EVID-010 adds the fork-only `lobster.scl.session-copy-lifecycle.v1` fixture.
It keeps export and deletion as separate operations over one owner-emitted copy
graph. It proves one exact-generation export, one ordinary deletion that
truthfully remains partial while archives, backup, export, and provider copies
survive, one bounded incognito-style purge after restart reconciliation, and
one stale-generation refusal before mutation. It adds no universal session
store, copy database, privacy service, retention owner, or deletion authority,
and authority remains `none`.

EVID-011 adds the fork-only
`lobster.ext.inert-definition-compatibility.v1` fixture. It preserves plugin,
Claw, and skill native identities and revisions while proving that unknown
optional semantics stay inert and inspectable and unknown required semantics
block before activation or mutation. It adds no shared extension manifest,
catalog, installer, runtime loader, or compatibility authority, and authority
remains `none`.

EVID-012 adds the fork-only
`lobster.rfn.protocol-negotiation-evolution.v1` fixture. It preserves the
TypeScript Gateway as the protocol owner and proves that N-1 admission is
restricted to node and probe modes, while the same adjacent operator range is
refused with structured mismatch details. Swift and Kotlin have guarded node
ranges; the Rust Quick Chat client remains current-only, and the fixture does
not claim Rust adjacent-version conformance or a release-duration policy.
It adds no transport, protocol dispatcher, downgrade adapter, release policy,
or runtime authority, and authority remains `none`.

EVID-013 adds the fork-only
`lobster.kcc.mixed-owner-restore-composition.v1` fixture. It preserves
OpenClaw's global and per-agent SQLite snapshot owners and proves one exact,
verified, current-schema owner set is ready for independent owner-native fresh
restore. One incompatible agent schema blocks the entire set before any
publication attempt. The fixture does not claim a shared capture generation,
cross-database transaction, completed restore, overwrite path, migration
authority, or runtime authority, and authority remains `none`.

EVID-014 adds the fork-only `lobster.ops.fleet-targeted-repair.v1` fixture.
It preserves OpenClaw Fleet's tenant-cell identity, per-cell operation lease,
exact attempt labels, health-gated upgrade, and previous-attempt restoration.
It proves one immutable three-cell rollout can select only its failed/restored
child for repair and converge without replaying healthy cells; a widened repair
is refused before repair mutation. It adds no production Fleet coordinator,
multi-host controller, containment or break-glass authority, container runtime
mutation, or runtime authority, and authority remains `none`.

EVID-015 adds the fork-only
`lobster.rfn.rust-gateway-live-admission.v1` fixture. It preserves the
TypeScript Gateway and node-pairing stores as owners while a clean-built Rust
process completes the real protocol-v4 nonce, device-v3 signature, device-token,
and empty capability-surface handshake. The same process offering obsolete
protocol v1 is refused with the Gateway-owned `PROTOCOL_MISMATCH` detail. It
proves authenticated admission only: no command is declared, no invocation is
executed, and runtime readiness, Rust authority, migration, release, rollback,
or TypeScript deletion remain unproven. Authority remains `none`.
This is the first fixture to promote its Rust runner from
`optional-until-cutover` to `required`; other fixtures retain their existing
runner expectation.

EVID-016 adds the fork-only
`lobster.rfn.rust-gateway-side-effect-free-invocation.v1` fixture. It preserves
the TypeScript Gateway, node pairing, command policy, and invocation registry as
owners while the admitted Rust process declares and executes only
`system.which`. Operator approval rotates the live pairing generation before
the Gateway dispatches one request with exact connection and pairing fences.
An allowlisted but undeclared `system.notify` request is refused before Rust
dispatch. The slice executes no effect and does not prove runtime readiness,
Rust authority, restart safety, canary selection, migration, rollback, or
TypeScript deletion. Authority remains `none`.

EVID-017 adds the fork-only
`lobster.rfn.rust-gateway-reconnect-continuity.v1` fixture. Two real Rust
processes reuse one approved device identity. The replacement connection
retires the original connection's pending `system.which` invocation with
`DISCONNECTED`; the superseded connection's delayed result is refused before
request dispatch with `PAIRING_CHANGED`, and a fresh invocation succeeds only
through the replacement connection ID while the pairing generation remains
unchanged. The slice proves
neither process restart state nor runtime readiness, effects, Rust authority,
canary selection, migration, rollback, or TypeScript deletion. Authority
remains `none`.

EVID-018 adds the fork-only
`lobster.rfn.rust-gateway-cold-restart-continuity.v1` fixture. A real Gateway
child process and a real Rust process execute one approved, side-effect-free
`system.which` invocation, both processes stop, and fresh processes reuse the
same durable Gateway state, persisted device identity, and persisted
owner-issued node token. The second
invocation requires no renewed capability approval and retains the same pairing
generation. The slice proves neither runtime readiness, Rust-owned durable
state, effects, Rust authority, canary selection, migration, rollback, nor
TypeScript deletion. Authority remains `none`.

EVID-019 adds the fork-only
`lobster.rfn.rust-gateway-unclean-restart-fencing.v1` fixture. A delayed
`system.which` request is observed by a real Rust process before the Gateway
and worker are killed. A fresh Gateway process reuses the durable pairing
generation but has no process-local pending invocation: a fresh authenticated
Rust process submits the old request ID and receives an explicit ignored
disposition, then a distinct Rust process settles exactly one new request.
The interrupted caller observes transport loss rather than recovered success.
The slice
proves neither durable invocation recovery, effects, runtime readiness,
Rust-owned durable state, Rust authority, migration, rollback, nor TypeScript
deletion. Authority remains `none`.

EVID-020 adds the fork-only
`lobster.rfn.rust-gateway-deadline-cancellation.v1` fixture. The TypeScript
Gateway owns one absolute invocation deadline. After Rust observes the
side-effect-free `system.which` request, the deadline settles the caller with
`TIMEOUT` and emits a correlated `node.invoke.cancel`. Rust observes that exact
cancel, submits its result afterward, and the Gateway explicitly ignores it.
A distinct Rust process then settles one fresh request on a new connection
without renewed capability approval or pairing-generation change. The slice
does not prove arbitrary caller abort, cooperative effect interruption,
streaming, idle deadlines, runtime readiness, Rust authority, migration,
rollback, or TypeScript deletion. Authority remains `none`.

EVID-021 adds the fork-only
`lobster.rfn.rust-gateway-stream-idle-timeout.v1` fixture. Rust emits
side-effect-free progress out of order; the TypeScript Gateway buffers and
delivers it in sequence, then owns the inactivity deadline after progress
stops. Rust observes the correlated cancel and submits both a late progress
frame and late result, which the Gateway explicitly ignores. A distinct Rust
process then settles one fresh request without renewed capability approval or
pairing-generation change. The slice does not prove effect interruption,
streaming input, runtime readiness, Rust authority, migration, rollback, or
TypeScript deletion. Authority remains `none`.

EVID-022 adds the fork-only
`lobster.rfn.rust-gateway-stream-input.v1` fixture. The TypeScript Gateway
rejects one oversized input frame without consuming a sequence number, then
sends two bounded JSON frames to Rust as sequences `0` and `1`. Rust returns
the observed inputs through the side-effect-free `system.which` proof, and the
Gateway rejects another input after terminal settlement. The slice does not
prove terminal emulation, a public operator streaming API, runtime readiness,
Rust authority, migration, rollback, or TypeScript deletion. Authority remains
`none`.

Reconstruct from a clean clone:

```text
corepack pnpm lobster:reconstruct -- --target <empty-directory-path>
corepack pnpm lobster:contracts
```

Only entries with an admitted state are applied. Source-only and rejected
entries remain inventory and never alter the reconstructed tree.

Admitted source may use either one exact commit (`cherry-pick`) or one exact
linear source generation (`cherry-pick-range`). Range entries pin the source
base, head, commit count, and aggregate stable patch ID. Reconstruction rejects
missing ancestry, merge commits, count or patch mismatches, and application
conflicts rather than silently rebasing the source.

When current-base drift prevents one source commit from applying, a range may
name an explicit B3 resolution commit. The resolution is valid only at its
pinned queue-prefix tree, must have a single parent with that same tree, carries
its own stable patch ID and B3 disposition identity, and substitutes only the
named source commit. The original range and per-commit source patch identities
remain part of the reconstruction result. Reconstruction also requires the
referenced disposition entry to match the B3 classification, admission state,
exact prefix commit, carried commit, and carried patch identity.
