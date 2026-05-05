/**
 * End-to-end integration: workspace manifest → lint + LKG in one
 * walk.
 *
 * Validates the architectural claim that drove putting the manifest
 * into oc-path: a single `buildWorkspaceManifest` call
 * feeds every consumer (LKG registration in this test, lint and
 * doctor in their own packages' integration tests). One walk, four
 * happy consumers.
 *
 * This test focuses on the LKG side because the LKG package has a
 * dependency on oc-path but not on oc-lint / oc-doctor —
 * exercising lint/doctor here would require pulling them into the
 * dep graph. The point is locked: same manifest shape feeds all of
 * them.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceManifest } from '@openclaw/oc-path';
import {
  FsLKGStore,
  InMemoryAuditSink,
  InMemoryRecoveryNoticeSink,
} from '../../src/extensions/lkg-fs/index.js';
import { registerOpenClawWorkspace } from '../../src/trackers/index.js';

function makeCtx() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'lkg-int-'));
  const audit = new InMemoryAuditSink();
  const notices = new InMemoryRecoveryNoticeSink();
  const store = new FsLKGStore({
    root: workspaceDir,
    auditSink: audit,
    recoveryNoticeSink: notices,
  });
  return { store, audit, notices, workspaceDir };
}

describe('manifest → multi-consumer (integration)', () => {
  it('INT-MULTI-01 single manifest walk feeds LKG end-to-end', async () => {
    const ctx = makeCtx();
    // Seed a realistic mini-workspace.
    writeFileSync(
      join(ctx.workspaceDir, 'AGENTS.md'),
      '## Tools\n- gh\n## Boundaries\n- never rm -rf\n',
      'utf-8',
    );
    writeFileSync(
      join(ctx.workspaceDir, 'gateway.jsonc'),
      '{ "version": 1 }\n',
      'utf-8',
    );
    mkdirSync(join(ctx.workspaceDir, 'sessions'));
    writeFileSync(
      join(ctx.workspaceDir, 'sessions', 'session.jsonl'),
      '{"event":"start"}\n{"event":"end"}\n',
      'utf-8',
    );
    mkdirSync(join(ctx.workspaceDir, 'workflows'));
    writeFileSync(
      join(ctx.workspaceDir, 'workflows', 'build.lobster'),
      'steps:\n  - id: build\n    command: echo hi\n',
      'utf-8',
    );

    // ONE walk. Manifest is now reusable across consumers.
    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);

    // Consumer 1: LKG.
    const lkgResult = registerOpenClawWorkspace(ctx.store, manifest);
    expect(lkgResult.registered.length).toBe(4);
    expect(lkgResult.byKind).toEqual({ md: 1, jsonc: 1, jsonl: 1, yaml: 1 });

    // Drive the LKG lifecycle: every registered file should promote
    // to LKG cleanly on first observe.
    for (const entry of lkgResult.registered) {
      const obs = await ctx.store.observe(entry.path);
      expect(obs.outcome).toBe('promoted');
      if (obs.outcome === 'promoted') {
        expect(obs.ocPath).toBe(entry.ocPath);
      }
    }

    // (Lint and doctor consumers would re-use the same manifest by
    // mapping `manifest.entries` to their own `LintFile` / `DoctorFile`
    // shapes — see the integration tests in oc-paths-lint and
    // oc-paths-doctor for the full host wiring example.)
  });

  it('INT-MULTI-02 manifest entry ocPath flows through to audit envelope', async () => {
    const ctx = makeCtx();
    writeFileSync(
      join(ctx.workspaceDir, 'AGENTS.md'),
      '## Tools\n## Boundaries\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ctx.workspaceDir);
    registerOpenClawWorkspace(ctx.store, manifest);

    await ctx.store.observe(join(ctx.workspaceDir, 'AGENTS.md'));

    const events = ctx.audit.list();
    expect(events.length).toBe(1);
    expect(events[0]?.ocPath).toBe('oc://AGENTS.md');
  });
});
