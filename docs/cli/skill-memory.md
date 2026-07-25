---
summary: "Recall completed work remembered by trusted tools"
read_when:
  - You need to verify that a business action completed
  - You need to find the session or run that remembered completed work
  - You need to count exact fact types across local agents
title: "Skill Memory"
---

# `openclaw skill-memory`

Recall durable facts that trusted tools attach to successful results. Skill
Memory is a record of completed work; it is separate from semantic memory,
workspace memory files, and vector search. An entry records an exact type such
as `case.resolved`, its originating agent,
session, run, and tool call, plus optional producer evidence. It is separate
from the metadata-only [`openclaw audit`](/cli/audit) lifecycle ledger.

```bash
openclaw skill-memory --type case.resolved
openclaw skill-memory --type payment.authorized --json
openclaw skill-memory --type case.resolved --count
openclaw skill-memory --id <MEMORY_ID>
```

The list output is newest first. Use `--json` when you need full evidence such
as an authorization code. List pages return a cursor when more records exist:

```bash
openclaw skill-memory --type case.resolved --limit 50 --json
openclaw skill-memory --type case.resolved --limit 50 --cursor <SEQUENCE> --json
```

## Filters

- `--type <type>` matches one exact producer-owned fact type.
- `--subject-type <type>` and `--subject-id <id>` match an affected business
  object. `--subject-id` requires `--subject-type`.
- `--agent <ids>` accepts comma-separated agent ids.
- `--session <key>` matches one stable session key or channel thread.
- `--run <id>` matches one run.
- `--count` counts the matching records without loading memory data.
- `--id <memory-id>` returns one full memory and cannot be combined with list
  filters.

## Storage

All agents served by one Gateway host use the configured local memory store.
It defaults to `~/.openclaw/state/skill-memory.sqlite`; configure
[`skillMemory.store.path`](/gateway/configuration-reference#skill-memory) when the
host needs a different local path.

The SQLite profile is single-host. Do not place the database on a network
filesystem or share it directly between Gateway hosts. Memory data has its own
backup, access, and retention boundary and is not a payment ledger or compliance
attestation.

Memory `data` can contain authorization codes and other sensitive business
evidence. Any operating-system user who can read the configured database can
read that evidence. Restrict access to the OpenClaw service account and protect
database snapshots and exports with the same policy as direct memory queries.

The initial profile does not automate retention, backup/export, or corruption
repair. Establish those operations before treating the store as production
evidence storage; use a consistent SQLite snapshot mechanism instead of copying
a live database file.
