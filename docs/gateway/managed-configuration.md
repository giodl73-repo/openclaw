---
summary: "Compose ordered configuration files for a hosted or fleet-managed Gateway"
read_when:
  - You operate OpenClaw from more than one configuration source
  - You need host-provided values without generating one baked config file
title: "Managed Configuration"
---

# Managed configuration

Managed configuration is an opt-in Gateway startup mode for operators that need
several configuration sources. Ordinary `openclaw.json` users do not need it
and see no behavior change.

The model is deliberately generic:

- each layer has an opaque ID and a file path;
- repeated `--config-layer` flags establish order;
- the first declared layer has the strongest authority;
- there are no built-in host, tenant, or operator roles.

OpenClaw composes the files into one validated runtime configuration before the
Gateway starts. An invalid layer or authority conflict prevents activation
instead of partially publishing a new configuration.

## Lobster Scout example

Lobster currently has to bake several inputs into one generated OpenClaw file.
A Scout deployment can instead keep the sources separate:

`/etc/lobster/openclaw-global.json`

```json5
{
  gateway: {
    mode: "local",
  },
}
```

`/etc/lobster/tenants/contoso-network.json`

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["https://scout.contoso.example"],
    },
  },
}
```

`~/.openclaw/openclaw.json`

```json5
{
  gateway: {
    port: 18789,
  },
}
```

Start the Gateway with the three sources in authority order:

```bash
export OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json"

openclaw gateway \
  --config-layer scout-global=/etc/lobster/openclaw-global.json \
  --config-layer tenant-network=/etc/lobster/tenants/contoso-network.json \
  --config-layer operator="$OPENCLAW_CONFIG_PATH"
```

The resulting Gateway configuration contains the global mode, tenant-scoped
origin, and operator-selected port. The names in this example are conventions
chosen by Lobster; OpenClaw does not assign meaning to them.

## Ordering and writes

Declare layers from strongest to weakest authority. Disjoint fields compose
normally. When two layers declare the same exact-owned field, the stronger
layer owns the effective value and incompatible declarations produce structured
findings under the configured authority contract.

The CLI startup surface is read-only. `OPENCLAW_CONFIG_PATH` must identify one
declared layer so OpenClaw's ordinary pre-action bootstrap has the same durable
primary source. While managed mode is active, Gateway-local and Control UI writes fail before
touching disk. A separate `openclaw config` process cannot infer startup flags,
so do not use it to mutate the primary layer. Automatic single-file reload is
disabled; edit the owning source file and fully stop/start the Gateway process
to activate a new complete chain.

Hosts that need transactional writes can use the programmatic managed
configuration facade, select one writable descriptor, and call its `write()`
operation. That path validates authority and the complete chain before
persistence; it is intentionally not bypassed by ordinary Gateway mutations.

Supply the flags on every process start, including starts performed by a service
manager. Managed configuration is a startup capability, not a new key stored in
`openclaw.json`.

## Includes and environment

Each file keeps the existing OpenClaw JSON5 and `$include` behavior. Relative includes resolve
from that layer's file. Process and service-manager environment substitution is applied after the
ordered sources are composed, so the Gateway validates and publishes one effective snapshot.

This first CLI slice rejects a top-level `env` declaration in a managed chain. In particular,
layers cannot redirect config/state selection or request shell-environment fallback during
bootstrap. Supply those values before the process starts. The bounded restriction keeps one
authority chain fixed across future-version guards and startup migrations.

## Failure and restart behavior

- A missing or invalid source prevents startup with structured layer findings.
- A failed activation leaves the previously published runtime snapshot intact.
- In-process Gateway restarts reuse the last accepted managed snapshot.
- Source changes require a full Gateway process stop/start.
- Gateway-local mutations fail before persistence in CLI managed startup mode.

Use managed configuration only when another system owns multiple durable
configuration sources. For a normal installation, continue using
`openclaw configure`, `openclaw config`, or a single `openclaw.json`.
