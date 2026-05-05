import { describe, expect, it } from 'vitest';
import {
  clobberedPathFor,
  isCompanionPath,
  lkgPathFor,
} from '../../../src/extensions/lkg-fs/paths.js';

describe('paths', () => {
  it('lkgPathFor appends .lkg', () => {
    expect(lkgPathFor('/ws/openclaw.json')).toBe('/ws/openclaw.json.lkg');
    expect(lkgPathFor('/ws/SOUL.md')).toBe('/ws/SOUL.md.lkg');
  });

  it('clobberedPathFor encodes timestamp filesystem-safely', () => {
    const cp = clobberedPathFor('/ws/x.json', '2026-05-02T16:30:00.000Z');
    expect(cp).toBe('/ws/x.json.clobbered.2026-05-02T16-30-00-000Z');
    expect(cp).not.toContain(':');
    expect(cp).not.toContain('.000');
  });

  it('isCompanionPath true for .lkg + .clobbered.* files', () => {
    expect(isCompanionPath('/ws/x.json.lkg')).toBe(true);
    expect(isCompanionPath('/ws/x.json.clobbered.2026-05-02T16-30-00-000Z')).toBe(true);
  });

  it('isCompanionPath false for plain workspace files', () => {
    expect(isCompanionPath('/ws/openclaw.json')).toBe(false);
    expect(isCompanionPath('/ws/SOUL.md')).toBe(false);
  });
});
