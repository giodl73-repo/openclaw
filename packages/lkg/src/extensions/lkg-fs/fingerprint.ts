/**
 * Fingerprint computation for the FS-backed LKG impl.
 *
 *   hash    = sha256-hex of raw bytes (bytes-only, deterministic)
 *   bytes   = byte length
 *   observedAt = ISO-8601 UTC at observation time
 *   fsStat  = POSIX stat fields (FS-specific appendix)
 *
 * @module @openclaw/lkg-fs/fingerprint
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { LKGFingerprint, LKGFsStat } from '../../plugin-sdk/lkg/types.js';

/** sha256-hex of `bytes`. Deterministic across runs and platforms. */
export function hashRaw(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compute a fingerprint from raw bytes + an optional `fs.Stats`. The
 * stat's POSIX-only fields go into the `fsStat` appendix; if no stat
 * is available (e.g., a backend without a stat primitive), pass
 * `undefined` and the appendix is omitted.
 *
 * `observedAt` defaults to "now" — callers needing deterministic
 * timestamps for tests / replay pass an explicit value.
 */
export function makeFingerprint(args: {
  raw: Buffer | Uint8Array;
  stat?: Stats;
  observedAt?: string;
  attestation?: string | null;
}): LKGFingerprint {
  const fsStat = args.stat ? toFsStat(args.stat) : undefined;
  return {
    hash: hashRaw(args.raw),
    bytes: args.raw.byteLength,
    observedAt: args.observedAt ?? new Date().toISOString(),
    ...(args.attestation !== undefined ? { attestation: args.attestation } : {}),
    ...(fsStat !== undefined ? { fsStat } : {}),
  };
}

function toFsStat(s: Stats): LKGFsStat {
  return {
    mtimeMs: s.mtimeMs ?? null,
    ctimeMs: s.ctimeMs ?? null,
    dev: s.dev !== undefined ? String(s.dev) : null,
    ino: s.ino !== undefined ? String(s.ino) : null,
    mode: s.mode ?? null,
    nlink: s.nlink ?? null,
    uid: s.uid ?? null,
    gid: s.gid ?? null,
  };
}
