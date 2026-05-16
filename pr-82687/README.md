# PR #82687 fresh proof artifacts

Fresh deterministic before/after proof for PR #82687.

- `pr-82687-doctor-config-preservation-before-after-proof.png`: before/after proof image generated from real `stripUnknownConfigKeys()` and `OpenClawSchema.safeParse()` output.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `4cba3e911404bbdcd6915b8741f0171e12b24e88` using a config containing legacy `defaultModel`, `mcp.servers`, two `agents.list[].description` values, and `unexpected`.
