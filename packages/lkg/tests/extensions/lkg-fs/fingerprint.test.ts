import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { hashRaw, makeFingerprint } from '../../../src/extensions/lkg-fs/fingerprint.js';

describe('fingerprint', () => {
  it('hashRaw is deterministic across calls for same bytes', () => {
    const buf = Buffer.from('hello world\n', 'utf-8');
    expect(hashRaw(buf)).toBe(hashRaw(buf));
  });

  it('hashRaw differs for different bytes', () => {
    expect(hashRaw(Buffer.from('a'))).not.toBe(hashRaw(Buffer.from('b')));
  });

  it('makeFingerprint includes hash + bytes + observedAt', () => {
    const fp = makeFingerprint({
      raw: Buffer.from('x'),
      observedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.bytes).toBe(1);
    expect(fp.observedAt).toBe('2026-05-02T00:00:00.000Z');
    expect(fp.fsStat).toBeUndefined();
    expect(fp.attestation).toBeUndefined();
  });

  it('makeFingerprint with stat fills fsStat appendix', () => {
    // Synthetic Stats — only the fields we use.
    const stat = {
      mtimeMs: 1700000000000,
      ctimeMs: 1700000000000,
      dev: 42,
      ino: 12345,
      mode: 0o100644,
      nlink: 1,
      uid: 1000,
      gid: 1000,
    } as unknown as import('node:fs').Stats;
    const fp = makeFingerprint({ raw: Buffer.from('x'), stat });
    expect(fp.fsStat).toBeDefined();
    expect(fp.fsStat?.dev).toBe('42');
    expect(fp.fsStat?.ino).toBe('12345');
    expect(fp.fsStat?.mode).toBe(0o100644);
  });

  it('makeFingerprint preserves attestation when supplied', () => {
    const fp = makeFingerprint({
      raw: Buffer.from('x'),
      attestation: 'sigstore-bundle-base64',
    });
    expect(fp.attestation).toBe('sigstore-bundle-base64');
  });

  it('makeFingerprint omits attestation when undefined (exactOptional)', () => {
    const fp = makeFingerprint({ raw: Buffer.from('x') });
    expect('attestation' in fp).toBe(false);
  });
});
