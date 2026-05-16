# PR #81423 fresh proof artifacts

Fresh deterministic before/after proof for PR #81423.

- `pr-81423-qmd-hyphenated-search-before-after-proof.png`: before/after proof image generated from real QMD search payload construction output in clean source worktrees.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `0f7460c4d99d028e07a629bfd178afc105a6c308` and verifies that QMD lexical search keeps raw hyphenated text while semantic vec/hyde/vsearch payloads normalize word-internal hyphens.
