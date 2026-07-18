---
summary: "Find, inspect, and count durable typed outcomes recorded by trusted tools"
read_when:
  - You need to verify that a business action completed
  - You need to find the session or run that recorded an outcome
  - You need to count exact outcome types across local agents
title: "Outcome receipts"
---

# `openclaw receipts`

Query durable business outcomes that trusted tools attach to successful results.
A receipt records an exact type such as `case.resolved`, its originating agent,
session, run, and tool call, plus optional producer evidence. It is separate
from the metadata-only [`openclaw audit`](/cli/audit) lifecycle ledger.

```bash
openclaw receipts --type case.resolved
openclaw receipts --type payment.authorized --json
openclaw receipts --type case.resolved --count
openclaw receipts --id <RECEIPT_ID>
```

The list output is newest first. Use `--json` when you need full evidence such
as an authorization code. List pages return a cursor when more records exist:

```bash
openclaw receipts --type case.resolved --limit 50 --json
openclaw receipts --type case.resolved --limit 50 --cursor <SEQUENCE> --json
```

## Filters

- `--type <type>` matches one exact producer-owned outcome type.
- `--subject-type <type>` and `--subject-id <id>` match an affected business
  object. `--subject-id` requires `--subject-type`.
- `--agent <ids>` accepts comma-separated agent ids.
- `--session <key>` matches one stable session key or channel thread.
- `--run <id>` matches one run.
- `--count` counts the matching records without loading receipt data.
- `--id <receipt-id>` returns one full receipt and cannot be combined with list
  filters.

## Storage

All agents served by one Gateway host use the configured local receipt store.
It defaults to `~/.openclaw/state/receipts.sqlite`; configure
[`audit.receipts.store.path`](/gateway/configuration-reference#audit) when the
host needs a different local path.

The SQLite profile is single-host. Do not place the database on a network
filesystem or share it directly between Gateway hosts. Receipt data has its own
backup, access, and retention boundary and is not a payment ledger or compliance
attestation.

Receipt `data` can contain authorization codes and other sensitive business
evidence. Any operating-system user who can read the configured database can
read that evidence. Restrict access to the OpenClaw service account and protect
database snapshots and exports with the same policy as direct receipt queries.

The initial profile does not automate retention, backup/export, or corruption
repair. Establish those operations before treating the store as production
evidence storage; use a consistent SQLite snapshot mechanism instead of copying
a live database file.
