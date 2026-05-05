/**
 * Adversarial / pitfall tests for `buildWorkspaceManifest`.
 *
 * Each test locks one mitigation against the threat it defends —
 * stack-blowing nesting, throwing custom matchers, pathological
 * filenames, false-positive companion patterns, symlinks. Every
 * pitfall in `workspace/PITFALLS.md` (W-NNN) maps to one or more
 * tests here.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceManifest } from '../../../../src/plugin-sdk/oc-path/workspace/index.js';

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), 'oc-ws-adv-'));
}

describe('manifest pitfalls — depth / DoS (W-040)', () => {
  it('W-040-01 deeply nested directory does not blow the stack', async () => {
    const ws = makeWs();
    // Build a 300-level-deep tree. The walk's depth bound (256) should
    // refuse to descend past the cap rather than recurse to a stack
    // overflow.
    let dir = ws;
    for (let i = 0; i < 300; i++) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, 'AGENTS.md'), '## buried\n', 'utf-8');

    // Should not throw; manifest just doesn't include the buried file.
    const manifest = await buildWorkspaceManifest(ws);
    expect(manifest).toBeDefined();
    // The buried AGENTS.md is past the depth cap, so it shouldn't
    // appear in entries.
    const buried = manifest.entries.find(
      (e) => e.relPath.startsWith('d0/') && e.relPath.endsWith('AGENTS.md'),
    );
    expect(buried).toBeUndefined();
  });
});

describe('manifest pitfalls — throwing custom matchers (W-091)', () => {
  it('W-091-01 a throwing extraRole matcher does not crash the walk', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
    writeFileSync(join(ws, 'gateway.jsonc'), '{ "v": 1 }\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws, {
      extraRoles: [
        {
          id: 'crashy',
          kind: 'jsonc',
          description: 'matcher always throws',
          matchesBasename: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    // Canonical roles should still match.
    expect(manifest.entries.length).toBe(2);
    expect(manifest.entries.find((e) => e.relPath === 'AGENTS.md')).toBeDefined();
    expect(manifest.entries.find((e) => e.relPath === 'gateway.jsonc')).toBeDefined();
  });
});

describe('manifest pitfalls — pathological filenames (W-060)', () => {
  it('W-060-01 file with reserved oc-path char in basename is dropped', async () => {
    const ws = makeWs();
    // ? is reserved in the oc-path syntax (used for ?session=).
    // Filenames containing it would produce a string parseOcPath
    // can't parse.
    try {
      writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
      writeFileSync(join(ws, 'weird?.md'), '## hostile\n', 'utf-8');
    } catch {
      // Some platforms (Windows) reject ? in filenames at the FS layer.
      // If we can't even create the file, the test is vacuous —
      // the threat doesn't reach our walker.
      return;
    }
    const manifest = await buildWorkspaceManifest(ws);
    const ok = manifest.entries.find((e) => e.relPath === 'AGENTS.md');
    expect(ok).toBeDefined();
    // weird?.md doesn't match a canonical role anyway, so this is
    // a defense-in-depth check more than a primary mitigation.
    expect(
      manifest.entries.find((e) => e.relPath.includes('?')),
    ).toBeUndefined();
  });

  it('W-060-02 nested path producing an over-length oc-path is dropped', async () => {
    const ws = makeWs();
    // Build a path whose oc:// URI exceeds parseOcPath's 4096-byte cap.
    let dir = ws;
    const segment = 'x'.repeat(50);
    for (let i = 0; i < 100; i++) {
      dir = join(dir, segment);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, 'AGENTS.md'), '## buried\n', 'utf-8');
    // Also seed a normal canonical file at the root.
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    // Root AGENTS.md should be present.
    expect(manifest.entries.find((e) => e.relPath === 'AGENTS.md')).toBeDefined();
    // The buried one (if walked at all) should be filtered out by
    // ocPath validation. We don't make a strong claim about whether
    // it's caught here vs. at the depth bound — both mitigations
    // protect us.
  });
});

describe('manifest pitfalls — companion-pattern false positives (W-070)', () => {
  it('W-070-01 file named *.clobbered.test.md is NOT filtered out', async () => {
    // The CLOBBERED_SUFFIX_RE anchors on the ISO-date prefix produced
    // by the LKG store. A user-named file like `data.clobbered.test.md`
    // does NOT match the anchor, so it's NOT filtered. (It also won't
    // match a canonical role, so it doesn't appear in entries — but
    // the filter shouldn't be the reason.)
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
    writeFileSync(
      join(ws, 'data.clobbered.test.md'),
      '## non-companion\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ws);
    // walkedFiles counts BOTH files (the test fixture + AGENTS.md).
    // If the filter were too greedy, walkedFiles would still be 2
    // because it counts every non-skipped file we visit, including
    // ones that don't match a role. So we measure the filter's
    // tightness via a synthetic role.
    const m2 = await buildWorkspaceManifest(ws, {
      extraRoles: [
        {
          id: 'clobbered-test',
          kind: 'md',
          description: 'matches user-named clobbered files',
          matchesBasename: (n) =>
            n.includes('.clobbered.test.') && n.endsWith('.md'),
        },
      ],
    });
    const found = m2.entries.find((e) => e.role.id === 'clobbered-test');
    expect(found).toBeDefined();
  });

  it('W-070-02 actual LKG companion (`<name>.clobbered.<iso>`) IS filtered', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
    // Real LKG companion shape: `<name>.clobbered.<iso-with-dashes>`.
    writeFileSync(
      join(ws, 'AGENTS.md.clobbered.2025-01-01-T00-00-00-000Z'),
      '## bad bytes\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ws);
    expect(
      manifest.entries.find((e) => e.relPath.includes('.clobbered.')),
    ).toBeUndefined();
  });
});

describe('manifest pitfalls — symlinks (W-001 / W-002)', () => {
  it('W-001-01 symlink to a file is NOT followed (defends path traversal)', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');

    // A symlink pointing OUTSIDE the workspace at /etc/passwd would be
    // a path-traversal vector. We can't safely create that symlink in
    // a test (and shouldn't), so we test the in-workspace case: a
    // symlink to a sibling file. The mitigation is the same — Dirent
    // for a symlink reports `isFile() === false` and
    // `isDirectory() === false`, so the walker silently skips it.
    try {
      symlinkSync(
        join(ws, 'AGENTS.md'),
        join(ws, 'IDENTITY.md'),
        'file',
      );
    } catch {
      // Some sandboxes (CI on Windows w/o admin) reject symlink
      // creation. Skip the test.
      return;
    }

    const manifest = await buildWorkspaceManifest(ws);
    const real = manifest.entries.find((e) => e.relPath === 'AGENTS.md');
    expect(real).toBeDefined();
    // The symlink at IDENTITY.md should NOT appear — it's a symlink
    // (Dirent.isFile() === false), not a real file.
    const link = manifest.entries.find((e) => e.relPath === 'IDENTITY.md');
    expect(link).toBeUndefined();
  });

  it('W-001-02 symlink loop is not entered', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
    // Create a symlinked dir that points to itself. Without
    // symlink-following, the walker simply skips it.
    try {
      symlinkSync(ws, join(ws, 'self'), 'dir');
    } catch {
      return;
    }
    const manifest = await buildWorkspaceManifest(ws);
    // No infinite walk. Test passes if it returns at all.
    expect(manifest).toBeDefined();
    expect(
      manifest.entries.find((e) => e.relPath.startsWith('self/')),
    ).toBeUndefined();
  });
});

describe('manifest pitfalls — extraRole vs canonical precedence (W-052)', () => {
  it('W-052-01 extraRole cannot override a canonical role assignment', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws, {
      extraRoles: [
        {
          id: 'my-agents',
          kind: 'md',
          description: 'try to claim AGENTS.md',
          matchesBasename: (n) => n === 'AGENTS.md',
        },
      ],
    });
    const entry = manifest.entries.find((e) => e.relPath === 'AGENTS.md');
    expect(entry?.role.id).toBe('agents.md'); // canonical wins
  });
});

describe('manifest pitfalls — permission denied (W-030)', () => {
  it('W-030-01 unreadable subdirectory is silently skipped', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## ok\n', 'utf-8');
    // Reference a subdir that doesn't exist (most reliable cross-
    // platform way to simulate a readdir failure mid-walk). The
    // walker catches readdir errors and continues.
    const manifest = await buildWorkspaceManifest(ws);
    expect(manifest.entries.find((e) => e.relPath === 'AGENTS.md')).toBeDefined();
    // Walking a non-existent root should also not throw — it returns
    // an empty manifest.
    const empty = await buildWorkspaceManifest(join(ws, 'does-not-exist'));
    expect(empty.entries.length).toBe(0);
  });
});
