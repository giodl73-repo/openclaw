/**
 * `@openclaw/lkg-fs` — reference filesystem-backed LKGStore impl.
 *
 * Public surface: `FsLKGStore` + audit/notice sinks (callers swap
 * in custom impls), plus the companion-path helpers (callers that
 * want to scan / clean up `.lkg` and `.clobbered.<ts>` files on
 * disk benefit from the canonical name computation).
 *
 * `hashRaw` and `makeFingerprint` are NOT exported — they're
 * internal to the store's promote / recover lifecycle. Callers that
 * need a content hash should compute one with `node:crypto` or read
 * `LKGFingerprint.hash` from an observation outcome.
 *
 * @module @openclaw/lkg-fs
 */

export { FsLKGStore, type FsLKGStoreOptions } from './store.js';
export {
  InMemoryAuditSink,
  type LKGAuditRecord,
  type LKGAuditSink,
} from './audit.js';
export {
  InMemoryRecoveryNoticeSink,
  type LKGRecoveryNotice,
  type LKGRecoveryNoticeSink,
} from './recovery-notice.js';
export { clobberedPathFor, isCompanionPath, lkgPathFor } from './paths.js';
