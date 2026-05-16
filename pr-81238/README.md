# PR #81238 fresh proof artifacts

Fresh deterministic before/after proof for PR #81238.

- `pr-81238-bundled-mcp-ref-union-schema-before-after-proof.png`: before/after proof image generated from real bundled MCP materialization output in clean source worktrees.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `f4beb91003afbc90b8569e4090399ac6462ff9b8` and verifies that bundled MCP local `$ref`/`$defs` schemas are inlined into provider-usable `oneOf` parameter schemas while valid page-parent arguments still validate.
