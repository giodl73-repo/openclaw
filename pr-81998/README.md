# PR #81998 fresh proof artifacts

Fresh deterministic before/after proof for PR #81998.

- `pr-81998-subagent-archive-default-before-after-proof.png`: before/after proof image generated from real `applyAgentDefaults({})` output in clean source worktrees.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `6f85e4e26d958fad46e075d1e66a207e09c79a93` and verifies that materialized config defaults include `agents.defaults.subagents.archiveAfterMinutes = 60` after the PR.
