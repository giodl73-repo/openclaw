/**
 * `@openclaw/lkg-git` — git-backed LKGStore impl.
 *
 * Public surface is intentionally narrow: callers get `GitLKGStore` plus
 * its option types. The low-level `git` / `gitBinary` invokers are NOT
 * exported — they're internal to the store's commit / restore lifecycle
 * and live in `git-cmd.js`. Callers that need to shell out to git
 * should use `node:child_process` (or a vetted wrapper) directly so the
 * store's invocation policy (env scrub, working-dir, signal handling)
 * can evolve without breaking consumers.
 *
 * @module @openclaw/lkg-git
 */

export { GitLKGStore, type GitAuthorship, type GitLKGStoreOptions } from './store.js';
