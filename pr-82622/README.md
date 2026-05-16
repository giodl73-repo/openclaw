# PR #82622 fresh proof artifacts

This branch intentionally replaces earlier bad/generated screenshots for PR #82622.

- `pr-82622-dist-runtime-before-after-proof.png`: deterministic before/after proof image generated from resolver output.
- `summary.txt`: copied terminal proof summary.

The proof compares `upstream/main` with PR head `3e53c8bb8165e01a79f9f43c6530f1eec41efaba` using `resolveBundledPluginGeneratedPath()` against a temp package root containing both `extensions/plugin/index.ts` and `dist-runtime/extensions/plugin/index.js`.
