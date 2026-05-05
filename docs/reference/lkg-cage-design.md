# `@openclaw/lkg` cage — design (both backends + labeled rollback)

Status: pre-RFC, drafting on the fork at `giodl73-repo/openclaw`. Filed 2026-05-05 by giodl@microsoft.com / Microsoft. Depends on the OcPath substrate (`docs/reference/oc-paths-substrate-design.md`).

## Summary

A new SDK contract `@openclaw/lkg` (Last-Known-Good) generalizes the existing `recoverConfigFromLastKnownGood` mechanism (shipped at commit `af56926e2fc4` for issue #70528) into a per-tracker contract any plugin can register against. Two reference implementations ship together:

- `@openclaw/lkg` — filesystem-backed, companion-file-per-tracker (the FS impl)
- `@openclaw/lkg-git` — git-backed second backend, closes [#40245](https://github.com/openclaw/openclaw/issues/40245) for multi-agent shared workspaces via three-way merge

Plus the **labels + atomic rollback feature** (closes [#14526](https://github.com/openclaw/openclaw/issues/14526) — *Proposal: safer self-update with pre-update backup + health check + auto-rollback/restore*). Operator workflow:

```sh
openclaw cage promote --label pre-upgrade-2026.4.10   # "I confirm this is good"
# do the upgrade
openclaw cage rollback --label pre-upgrade-2026.4.10  # restore atomically
```

CLI bin is `openclaw cage` (lobster-themed; the cage holds your good states until you need to fall back). Substrate identity stays `@openclaw/lkg` (technical-precise).

The earlier two-PR proposal (`upstream-pr1-lkg` + `upstream-pr2-lkg-git`) collapses into this single PR — *"both backends in one PR keeps the contract honestly backend-agnostic in one review cycle"*. Same contract, two native impls, one set of operator-facing verbs.

## Problem

Today's gateway has one LKG mechanism (`recoverConfigFromLastKnownGood` for `openclaw.json`) but multiple shapes of artifact that NEED LKG-tracking:

| Artifact | What "good" means | Current state |
|---|---|---|
| Gateway config (`openclaw.json`) | parses + passes existing config validators | covered by `recoverConfigFromLastKnownGood` |
| Workspace markdown | parses + passes per-file validators (e.g., MEMORY.md frontmatter) | not LKG-tracked |
| PolicyIR (`policy.jsonc`) | parses + passes shape-hash check | not LKG-tracked |
| Session state (`sessions/*.jsonl`) | line-parses + has terminal event | not LKG-tracked; #13700 / #17211 / #58028 / #60864 cluster |
| Memory `MEMORY.md` | dreaming-promoted entries are valid markdown links | not LKG-tracked |
| Shared multi-agent workspace files | last-known-good across multiple writers | not LKG-tracked; #40245 |

There's no contract abstraction for "this artifact is LKG-tracked." Each future consumer would invent its own `recoverXFromLastKnownGood` if we don't generalize.

## What changes

### 1. `LKGStore` contract

```ts
interface LKGStore {
  register<TParsed, TIssue>(tracker: LKGTracker<TParsed, TIssue>): void;
  observe(path: string, opts?: LKGObserveOptions): Promise<LKGObservation>;
  readLastKnownGood(path: string): Promise<Uint8Array>;
  getEntry(path: string): LKGEntry | null;

  // Labels feature — closes #14526
  promoteAll(opts?: PromoteAllOptions): Promise<PromoteAllResult>;
  listLabels(): Promise<readonly LabelEntry[]>;
  rollbackToLabel(label: string, opts?: LKGObserveOptions): Promise<RollbackResult>;
  deleteLabel(label: string): Promise<DeleteLabelResult>;
}
```

`observe(path)` is the validation-driven lifecycle (read → parse → validate → react: promote / valid / recover / skipped / failed). `promoteAll(opts.label)` is the operator-driven verb that pins the current cohort under an immutable name. `rollbackToLabel(name)` does atomic two-phase restore: phase 1 verifies every companion exists + matches recorded hash; phase 2 swaps each active path. If verify fails, no writes happen.

### 2. `LKGTracker<TParsed, TIssue>`

```ts
interface LKGTracker<TParsed = unknown, TIssue = ValidationIssue> {
  readonly path: string;
  readonly ocPath?: OcPath;       // workspace-relative oc:// for audit correlation
  readonly requires?: { sdkVersion: string };

  parse(raw: string): TParsed;
  validate(parsed: TParsed): ValidationResult<TIssue>;
  suspiciousReasons?(args: {...}): readonly string[];
  shouldRecover?(snapshot: {...}): boolean;
}
```

Plugins register one tracker per path. The store rejects path collisions (`LKG_TRACKER_PATH_COLLISION`) and out-of-root paths (`LKG_TRACKER_PATH_INVALID`). `TIssue` lets trackers carry richer issue vocabularies (e.g., PolicyIR's structured violations) without downcasting through `ValidationIssue`.

### 3. Two backends, same contract

**FS impl** (`@openclaw/lkg`): companion files at `<path>.lkg` (last-known-good bytes), `<path>.clobbered.<ts>` (preserved bad bytes after a recovery), `<path>.lkg.label.<name>` (operator-pinned label). State persists in `<root>/.openclaw/lkg-health.json` (mirrors upstream's existing `config-health.json` convention).

**Git impl** (`@openclaw/lkg-git`): promote = `git commit`, recover = `git checkout HEAD -- <path>`, label = `lkg/<name>` git tag, rollback = `git checkout lkg/<name> -- <files>`. Closes #40245 for multi-agent shared workspaces — under any deployment exposing a shared git working tree (FUSE-mounted shared FS, NFS, SMB, or distinct local clones with a remote), two agents editing the same file no longer silently lose one edit; git's three-way merge handles it.

Same contract, native semantics per backend. Reviewing them together validates the contract is honestly backend-agnostic.

### 4. CLI: `openclaw cage`

```
openclaw cage status [<dir>]                                — workspace-wide observe
openclaw cage observe <file>                                — single-file observe
openclaw cage promote [<dir>] [--label <name>]              — operator-driven promote
openclaw cage labels [<dir>]                                — list labeled pins
openclaw cage rollback --label <name> [<dir>]               — atomic restore
openclaw cage delete-label <name> [<dir>]                   — escape hatch for immutable labels
openclaw cage list-trackers [<dir>]                         — enumerate registered trackers
openclaw cage fingerprint <file>                            — compute sha256 over file bytes
```

The `cage` brand is the lobster-themed verb (sister to `pinch` / `path`); the substrate identity (`@openclaw/lkg`) stays technical-precise. *The cage holds your good states until you need to fall back.*

### 5. Labels feature (closes #14526)

Operator workflow:

```sh
openclaw cage promote --label pre-upgrade-2026.4.10        # pin current good state
# do the upgrade
# tools break / behavior wrong / something feels off
openclaw cage rollback --label pre-upgrade-2026.4.10       # back to known-good cohort
```

Labels are **immutable** (re-pinning the same name throws `LKG_LABEL_DUPLICATE`). The escape hatch is `delete-label` — operators who confirm an upgrade stuck call it to free disk space. Atomicity is **all-or-nothing**: rollback verifies every tracker's labeled bytes match the recorded hash BEFORE any active-path write. Phase-2 writes are sequential per file (atomic per write via tmp+rename); a process crash mid-phase-2 leaves the workspace partially rolled back, which the gateway's startup-time `observe` cycle catches and audits.

## Goals

- **One contract, two backends.** Same `LKGStore` interface; FS uses companion files, git uses commits + tags. Plugin authors reason about LKG once.
- **Per-kind validators** that consume parsed ASTs from PR-1's substrate (md/jsonc/jsonl/yaml). The tracker's `parse` and `validate` round through the OcPath substrate.
- **Labels for upgrade recovery.** Operators say "this is good" with a name; rollback restores the cohort atomically. Closes #14526.
- **Multi-agent shared workspaces** via the git backend. Closes #40245.
- **Migrate `recoverConfigFromLastKnownGood` in-PR** as the first reference consumer. Behavior byte-for-byte unchanged (conformance test pins it).

## Non goals

- **Auto-detection of "this is now good after upgrade."** Operators decide; labels are explicit. Auto-rollback after a smoke-test failure is a v1 concern.
- **Cross-tenant LKG.** One `LKGStore` per tenant; cross-tenant collisions are structurally impossible.
- **Replacing existing `openclaw doctor` repair flows.** The cage substrate is for fast, atomic state restoration to a known-good moment; doctor is for fix-forward repairs. Different tools, complementary.

## Integration into openclaw

This branch (`substrate/lkg-cage`) demonstrates two integration points:

1. **`openclaw cage` CLI verb** — new `register.cage.ts` in `src/cli/program/` adds the `cage` parent command with pass-through dispatch. Same minimal-dispatcher pattern as `register.path.ts` and `register.pinch.ts`.

2. **Workspace deps** — `@openclaw/lkg` and `@openclaw/lkg-git` added as root workspace deps so the upstream CLI surface can import the substrate's `runCli`.

The deeper integration — migrating the existing `recoverConfigFromLastKnownGood` to use the new contract — is a follow-up. The substrate package itself can be reviewed independently.

## Open questions

- **Disk usage for labels**: each label pins N companion files (one per tracker). After 20 upgrades, that's 20× tracker count of files. `delete-label` exists; should there be an automatic age-based prune? (v1.)
- **Git tag namespacing**: today `lkg/<name>` prefix. Should `lkg/` be reserved by upstream policy, or is `<name>` operator-namespaced?
- **Cross-tenant audit envelope correlation**: today `correlationEventId` is opaque; SIEM integration patterns vary. Worth a separate spec.

## Test surface

- `packages/lkg/tests/` — 145 tests across 12 files (claws-hapi side). Covers contract types, FsLKGStore lifecycle, per-kind trackers, manifest registration, all 4 label operations, two-phase atomicity, persistence across process restart, tamper detection.
- `packages/lkg-git/tests/` — 15+ tests. Covers GitLKGStore lifecycle + the labels feature against real git ops.
- Real-world validation: 25-fixture suite at `validation/` (claws-hapi side).

## Provenance

Drafted with Claude Opus 4.7 (1M context) by giodl@microsoft.com. The 2-PRs-merged-into-1 design call (2026-05-05): *"it's nicer to just get both backends in and seen in the same PR to make sure they are consistent."* Companion specs at `docs/reference/oc-paths-substrate-design.md` (PR-1 dependency), `docs/reference/policy-anchoring-design.md` (sister substrate that anchors decisions in LKG fingerprints).
