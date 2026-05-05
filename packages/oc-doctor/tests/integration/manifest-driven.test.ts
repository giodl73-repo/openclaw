/**
 * End-to-end integration: workspace manifest → doctor adapter.
 *
 * Validates that a host wiring up oc-doctor can use oc-path's
 * `buildWorkspaceManifest` as the file-discovery layer instead of
 * inventing its own walker. The manifest's per-entry `role.kind` drives
 * dispatch to the right `parseXxx` before feeding `DoctorFile[]` to
 * the adapter.
 *
 * Mirrors the canonical "how do I run the doctor against my workspace?"
 * path PR-3 documents.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceManifest,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseYaml,
  type OcAst,
  type OcKind,
  type WorkspaceManifestEntry,
} from '@openclaw/oc-path';
import {
  STARTER_FIXERS_V0_CONTRIBUTIONS,
} from '../../src/extensions/ocdoctor-fixers-starter/index.js';
import type {
  DoctorContext,
  DoctorFile,
} from '../../src/plugin-sdk/oc-doctor/types.js';

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), 'oc-doc-int-'));
}

function parseForKind(kind: OcKind, raw: string): OcAst {
  switch (kind) {
    case 'md':
      return parseMd(raw).ast;
    case 'jsonc':
      return parseJsonc(raw).ast;
    case 'jsonl':
      return parseJsonl(raw).ast;
    case 'yaml':
      return parseYaml(raw).ast;
  }
}

function manifestEntryToDoctorFile(entry: WorkspaceManifestEntry): DoctorFile {
  const raw = readFileSync(entry.path, 'utf-8');
  return {
    name: entry.relPath.split('/').pop() ?? entry.relPath,
    path: entry.path,
    raw,
    ast: parseForKind(entry.role.kind, raw),
  };
}

describe('manifest → doctor adapter (integration)', () => {
  it('INT-DOC-01 manifest drives detect across canonical artifacts', async () => {
    const ws = makeWs();
    // AGENTS.md without `## Boundaries` triggers the starter fixer
    // `agents-add-boundaries-stub`.
    writeFileSync(join(ws, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToDoctorFile);
    const writes = new Map<string, string>();
    const ctx: DoctorContext = {
      workspaceDir: ws,
      files,
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    };

    // Aggregate findings across all starter contributions.
    const findings = (
      await Promise.all(
        STARTER_FIXERS_V0_CONTRIBUTIONS.map((c) => c.detect(ctx)),
      )
    ).flat();

    const boundaries = findings.find(
      (f) => f.contributionId === 'starter-v0/agents/add-boundaries-stub',
    );
    expect(boundaries).toBeDefined();
    expect(boundaries?.fileName).toBe('AGENTS.md');
  });

  it('INT-DOC-02 fix path writes to manifest entry path', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## Tools\n- gh\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToDoctorFile);
    const writes = new Map<string, string>();
    const ctx: DoctorContext = {
      workspaceDir: ws,
      files,
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    };

    // Find + fix the boundaries finding.
    const contribution = STARTER_FIXERS_V0_CONTRIBUTIONS.find(
      (c) => c.id === 'starter-v0/agents/add-boundaries-stub',
    );
    expect(contribution).toBeDefined();
    if (contribution === undefined) return;

    const findings = await contribution.detect(ctx);
    expect(findings.length).toBeGreaterThan(0);

    const fixResult = await contribution.fix(ctx, findings[0]!);
    expect(fixResult.outcome).toBe('fixed');
    // The adapter wrote to the path the manifest gave us.
    const agentsAbsPath = join(ws, 'AGENTS.md');
    expect(writes.has(agentsAbsPath)).toBe(true);
    expect(writes.get(agentsAbsPath)).toContain('## Boundaries');
  });

  it('INT-DOC-03 manifest skips non-canonical files; doctor only sees the right surface', async () => {
    const ws = makeWs();
    writeFileSync(
      join(ws, 'AGENTS.md'),
      '## Tools\n- gh\n## Boundaries\n- never rm -rf\n',
      'utf-8',
    );
    writeFileSync(join(ws, 'README.md'), '# README\n', 'utf-8');
    writeFileSync(join(ws, 'package.json'), '{}\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToDoctorFile);

    expect(files.length).toBe(1);
    expect(files[0]?.name).toBe('AGENTS.md');

    const ctx: DoctorContext = {
      workspaceDir: ws,
      files,
      writeFile: async () => {
        /* noop */
      },
    };
    const findings = (
      await Promise.all(
        STARTER_FIXERS_V0_CONTRIBUTIONS.map((c) => c.detect(ctx)),
      )
    ).flat();
    // Well-formed AGENTS.md → no boundaries-stub finding.
    expect(
      findings.find(
        (f) => f.contributionId === 'starter-v0/agents/add-boundaries-stub',
      ),
    ).toBeUndefined();
  });

  it('INT-DOC-04 nested per-plugin AGENTS.md gets fixed too', async () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'plugins', 'gateway-policy'), { recursive: true });
    writeFileSync(
      join(ws, 'plugins', 'gateway-policy', 'AGENTS.md'),
      '## Tools\n- gh\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToDoctorFile);

    const writes = new Map<string, string>();
    const ctx: DoctorContext = {
      workspaceDir: ws,
      files,
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    };

    const contribution = STARTER_FIXERS_V0_CONTRIBUTIONS.find(
      (c) => c.id === 'starter-v0/agents/add-boundaries-stub',
    );
    if (contribution === undefined) return;

    const findings = await contribution.detect(ctx);
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0]!;
    await contribution.fix(ctx, f);

    const pluginPath = join(ws, 'plugins', 'gateway-policy', 'AGENTS.md');
    expect(writes.has(pluginPath)).toBe(true);
  });
});
