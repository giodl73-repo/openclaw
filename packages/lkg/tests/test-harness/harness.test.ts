/**
 * Smoke tests for the LKG test-harness.
 */
import { describe, expect, it } from 'vitest';
import {
  assertFails,
  assertPromotes,
  assertRecovers,
  assertSkipsForNoLkg,
  assertSkipsForPluginLocal,
  makeTestStore,
  runTracker,
} from '../../src/test-harness/index.js';
import type { LKGTracker } from '../../src/plugin-sdk/lkg/types.js';

interface Cfg {
  readonly version: number;
}

const versionTracker = (path: string): LKGTracker<Cfg> => ({
  path,
  parse: (raw) => JSON.parse(raw) as Cfg,
  validate: (parsed) =>
    parsed.version === 1
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ path: 'version', message: 'bad version' }] },
});

describe('LKG test-harness', () => {
  it('TH-01 makeTestStore returns an isolated workspace', () => {
    const ctx = makeTestStore();
    expect(ctx.workspaceDir).toMatch(/lkg-harness-/);
    expect(ctx.path.endsWith('tracked.json')).toBe(true);
  });

  it('TH-02 custom filename via opts', () => {
    const ctx = makeTestStore({ filename: 'gateway.jsonc' });
    expect(ctx.path.endsWith('gateway.jsonc')).toBe(true);
  });

  it('TH-03 assertPromotes passes on valid first observe', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 1 });
    ctx.store.register(versionTracker(ctx.path));
    await expect(assertPromotes(ctx)).resolves.toBeUndefined();
  });

  it('TH-04 assertPromotes throws on a different outcome', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 99 });
    ctx.store.register(versionTracker(ctx.path));
    await expect(assertPromotes(ctx)).rejects.toThrow(/expected promote/);
  });

  it('TH-05 assertSkipsForNoLkg passes on first invalid observe with no LKG', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 99 });
    ctx.store.register(versionTracker(ctx.path));
    await expect(assertSkipsForNoLkg(ctx)).resolves.toBeUndefined();
  });

  it('TH-06 assertRecovers passes after promote → corrupt → observe', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 1 });
    ctx.store.register(versionTracker(ctx.path));
    await assertPromotes(ctx);
    ctx.write({ version: 99 });
    await expect(assertRecovers(ctx)).resolves.toBeUndefined();
  });

  it('TH-07 assertSkipsForPluginLocal passes when shouldRecover returns false', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 99 });
    ctx.store.register({
      path: ctx.path,
      parse: (raw) => JSON.parse(raw) as Cfg,
      validate: () => ({ valid: false, issues: [{ path: '', message: 'x' }] }),
      shouldRecover: () => false,
    });
    await expect(assertSkipsForPluginLocal(ctx)).resolves.toBeUndefined();
  });

  it('TH-08 assertFails matches reason via substring', async () => {
    const ctx = makeTestStore();
    ctx.write(
      JSON.stringify({ version: 1, t: '__OPENCLAW_REDACTED__' }) + '\n',
    );
    ctx.store.register(versionTracker(ctx.path));
    await expect(assertFails(ctx, 'sentinel-detected')).resolves.toBeUndefined();
  });

  it('TH-09 assertFails matches reason via regex', async () => {
    const ctx = makeTestStore();
    ctx.write('{"version": 1, "x": "__OPENCLAW_REDACTED__"}\n');
    ctx.store.register(versionTracker(ctx.path));
    await expect(assertFails(ctx, /sentinel/i)).resolves.toBeUndefined();
  });

  it('TH-10 runTracker exposes the raw outcome for custom assertions', async () => {
    const ctx = makeTestStore();
    ctx.write({ version: 1 });
    ctx.store.register(versionTracker(ctx.path));
    const obs = await runTracker(ctx);
    expect(obs.outcome).toBe('promoted');
  });
});
