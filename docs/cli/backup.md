---
summary: "CLI reference for creating, verifying, retrieving, and materializing local OpenClaw archives"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You want to preview which paths would be included before reset or uninstall
  - You want to inspect a verified backup in a non-active staging directory
  - You want to materialize a continuity archive into a clean offline root
title: "Backup"
---

# `openclaw backup`

Create a local backup archive for OpenClaw state, config, auth profiles, channel/provider credentials, sessions, and optionally workspaces.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
openclaw backup retrieve ./backup.tar.gz --destination ./restored
openclaw backup materialize ./continuity.tar.gz --destination ./offline-root
openclaw backup plan-restore ./continuity.tar.gz --materialized ./offline-root --authorize ~/.openclaw ~/.openclaw.json
```

## Notes

- The archive embeds a `manifest.json` with resolved source paths, archive layout, path-free backup-asset component IDs, explicit dependencies, and deterministic restore order. Verification accepts older manifests without component metadata but rejects partial or invalid component graphs.
- New manifests also carry a fail-closed Archived continuity assessment. Ordinary backups are not Archived recovery points: the assessment reports excluded legacy transcripts, included OAuth/auth-profile material, partial capture, and unresolved config-secret classification using stable blocker codes. Verification and retrieval preserve this evidence but never activate the archive.
- Default output is a timestamped `.tar.gz` archive in the current working directory. Timestamped filenames use your machine's local timezone and include the UTC offset. If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten. Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` checks that the archive contains exactly one root manifest, rejects traversal-style archive paths, and confirms every manifest-declared payload exists in the tarball. `openclaw backup create --verify` runs that validation immediately after writing the archive.
- `openclaw backup create --only-config` backs up just the active JSON config file.
- `openclaw backup retrieve <archive> --destination <path>` copies and verifies the archive, then extracts its manifest and payload into a new private staging directory. The destination must not already exist.
- Retrieval rejects links, special entries, unsafe paths, and archives that exceed its entry or expanded-size safety limits. If extraction fails, OpenClaw removes the incomplete destination.
- Retrieval does **not** activate the staged files as live OpenClaw state. Inspect the staging directory manually; native restore and activation are not implemented by this command.
- `openclaw backup materialize <archive> --destination <path>` accepts only a verified continuity artifact with a complete component graph. It copies state, config, and workspace files into a new owner-private offline filesystem root in declared dependency order and writes `.openclaw-continuity-materialization.json` with the exact archive and manifest identities.
- `openclaw backup plan-restore <archive> --materialized <path> --authorize <path...>` re-verifies the continuity archive, matches its non-active materialization receipt, validates the safe tree shape, resolves exact original targets, and prints their publication groups. Every outer publication root must be listed explicitly. The result remains blocked on per-file materialized content identity, a launcher lease, and atomic no-replace publication. The command does not create restore staging, publish targets, or change Gateway startup.
- Before creating the offline root, materialization rejects malformed or newer artifact runtime versions, artifacts captured on another platform, corrupt packaged SQLite databases, and newer shared-state or agent-state schemas. Arbitrary plugin and workspace databases are not interpreted as core schemas.
- The materialization receipt reports `activated: false`, `activationReady: false`, and `effectiveArchived: false`. It projects the artifact's closed reconstruction, external-dependency, and ephemeral obligations; it does not infer executable work from the broad runtime state inventory.
- Materialized absolute paths remain under their archive namespace (`posix/`, `windows/`, or `relative/`) inside the selected destination. Materialization never writes to the original source paths, activates live state, starts the Gateway, resolves credentials, or establishes effective Archived.
- Materialization refuses existing destinations, links, hard links, ambiguous component ownership, unexpected overwrite, and incomplete payload ownership. Failed output is removed rather than left success-shaped.
- Compatibility validation does not rebuild derived state, resolve host credentials or placement, create runtime transients, start OpenClaw, or rewrite live paths.
- Continuity capture fails closed while legacy file-backed delivery queue entries or delivered markers remain. Installed plugin `node_modules` trees are omitted and counted in the artifact's owner-reinstall obligation.

## What gets backed up

`openclaw backup create` plans sources from your local OpenClaw install:

- The state directory (usually `~/.openclaw`)
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

Auth profiles and other per-agent runtime state live in SQLite under the state directory (`agents/<agentId>/agent/openclaw-agent.sqlite`), so they are covered by the state backup entry automatically.

`--only-config` skips state, credentials-directory, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive: if config, the credentials directory, or a workspace already live inside the state directory, they are not duplicated as separate top-level backup sources. Missing paths are skipped.

During archive creation, OpenClaw skips known live-mutation files with no restoration value: active agent session transcripts, cron run logs, rolling logs, delivery queues, socket/pid/temp files under the state directory, and related durable-queue temp files. The JSON result's `skippedVolatileCount` reports how many files were intentionally omitted. SQLite databases under the state directory are snapshotted safely (`VACUUM INTO`) rather than copied live, so open WAL/SHM files do not corrupt the backup.

Installed plugin source and manifest files under the state directory's `extensions/` tree are included, but their nested `node_modules/` dependency trees are skipped as rebuildable install artifacts. After restoring an archive, use `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force` if a restored plugin reports missing dependencies.

## Invalid config behavior

`openclaw backup` bypasses the normal config preflight so it can still help during recovery. Workspace discovery depends on a valid config, so `openclaw backup create` fails fast when the config file exists but is invalid and workspace backup is still enabled.

For a partial backup in that situation, rerun with `--no-include-workspace`: it keeps state, config, and the external credentials directory in scope while skipping workspace discovery entirely.

`--only-config` also works when the config is malformed, since it does not parse the config for workspace discovery.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit. Practical limits come from:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive with `--verify` or `openclaw backup verify`
- Destination filesystem behavior: OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. Use `--no-include-workspace` for a smaller/faster backup, or `--only-config` for the smallest archive.

## Related

- [CLI reference](/cli)
