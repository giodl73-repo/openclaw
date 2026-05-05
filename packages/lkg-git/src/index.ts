/**
 * `@openclaw/lkg-git` — claws-hapi prototype of the upstream
 * `lkg-recovery` PR-2 surface (git-backed second-backend LKGStore
 * impl). Same `LKGStore` contract as `@openclaw/lkg`'s
 * filesystem-backed impl; consumers swap backend via configured store
 * choice.
 *
 * Closes [#40245](https://github.com/openclaw/openclaw/issues/40245)
 * multi-agent shared workspace via git's three-way merge — replaces
 * last-writer-wins for shared state.
 *
 * @module @openclaw/lkg-git
 */

export * from './extensions/lkg-git/index.js';
