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
