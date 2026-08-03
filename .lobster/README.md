# Lobster fork metadata

This directory contains fork-only reconstruction and evidence metadata. It is
not imported by OpenClaw production code and does not change default runtime,
configuration, package, plugin, skill, or CLI behavior.

- `queue.json` pins the upstream base and ordered carried-source admission.
- `sources.json` captures exact upstream pull request generations as quarantined
  inventory with no build, evidence, release, or runtime authority.
- `baseline.json` pins cross-platform vanilla-equivalent commands.
- `fixtures.json` reserves stable fixture identities.
- `disposition.json` separates retained metadata from deletion obligations.

Reconstruct from a clean clone:

```text
corepack pnpm lobster:reconstruct -- --target <empty-directory-path>
```

Only entries with an admitted state are applied. Source-only and rejected
entries remain inventory and never alter the reconstructed tree.
