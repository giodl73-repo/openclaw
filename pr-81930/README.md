# PR #81930 fresh proof artifacts

Fresh deterministic before/after proof for PR #81930.

- `pr-81930-memory-tts-guidance-before-after-proof.png`: before/after proof image generated from real prompt builder output in clean source worktrees.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `89fb5581492a426de595d4398e1788122644e85a` and verifies that MEMORY.md voice instructions are treated as durable guidance and generic TTS guidance defers to MEMORY/local voice workflow instructions.
