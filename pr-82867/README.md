# PR #82867 proof

This proof uses a deterministic source-level session-store fixture for issue #47534.

- `before-origin-main.log`: origin/main has no doctor session snapshot stale-runtime detector or doctor contribution.
- `after-pr-82867.log`: PR head detects stale POSIX install-root, temp-backed, and Windows runtime paths while avoiding current-runtime and workspace false positives.
