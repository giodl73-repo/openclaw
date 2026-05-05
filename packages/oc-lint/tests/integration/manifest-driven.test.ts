/**
 * End-to-end integration: workspace manifest → lint runner.
 *
 * Validates that a host wiring up oc-lint can use oc-path's
 * `buildWorkspaceManifest` as the file-discovery layer instead of
 * inventing its own walker. The manifest's per-entry `role.kind` is
 * exactly what callers need to dispatch to the right `parseXxx`
 * function before feeding files to the runner.
 *
 * This test mirrors the canonical "how do I run the linter against
 * my workspace?" path that PR-2 documents — verifying the manifest
 * is shape-compatible with `LintFile`.
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
import { runLint } from '../../src/oc-lint/runner.js';
import { STARTER_RULES_V0 } from '../../src/extensions/oclint-rules-starter/index.js';
import type { LintFile } from '../../src/oc-lint/runner.js';

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), 'oc-lint-int-'));
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

function manifestEntryToLintFile(entry: WorkspaceManifestEntry): LintFile {
  const raw = readFileSync(entry.path, 'utf-8');
  return {
    name: entry.relPath.split('/').pop() ?? entry.relPath,
    ast: parseForKind(entry.role.kind, raw),
  };
}

describe('manifest → lint runner (integration)', () => {
  it('INT-LINT-01 manifest entries feed runLint with the right kinds', async () => {
    const ws = makeWs();
    // Seed canonical openclaw artifacts. AGENTS.md is missing the
    // `## Boundaries` section — that's what `agents-missing-boundaries`
    // rule should catch.
    writeFileSync(
      join(ws, 'AGENTS.md'),
      '## Tools\n- gh\n',
      'utf-8',
    );
    writeFileSync(join(ws, 'gateway.jsonc'), '{ "version": 1 }\n', 'utf-8');

    // Build the manifest — the host's discovery layer.
    const manifest = await buildWorkspaceManifest(ws);
    expect(manifest.entries.length).toBe(2);

    // Map manifest entries → LintFiles via the per-kind parser.
    const files = manifest.entries.map(manifestEntryToLintFile);

    // Run the linter against the discovered set.
    const result = runLint({
      rules: STARTER_RULES_V0,
      files,
    });

    // The starter rule pack should fire `agents-missing-boundaries`
    // for our seeded AGENTS.md.
    const boundariesFinding = result.diagnostics.find(
      (d) => d.ruleId === 'starter-v0/agents/missing-boundaries',
    );
    expect(boundariesFinding).toBeDefined();
    expect(boundariesFinding?.fileName).toBe('AGENTS.md');
  });

  it('INT-LINT-02 manifest skips non-canonical files; lint only sees the right surface', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## Tools\n## Boundaries\n', 'utf-8');
    writeFileSync(join(ws, 'README.md'), '# README\n', 'utf-8');
    writeFileSync(join(ws, 'package.json'), '{}\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToLintFile);

    // README.md and package.json don't match canonical roles, so
    // they're not in the manifest, so the linter never sees them.
    expect(files.length).toBe(1);
    expect(files[0]?.name).toBe('AGENTS.md');

    const result = runLint({ rules: STARTER_RULES_V0, files });
    // No `agents-missing-boundaries` finding — the file is well-formed.
    expect(
      result.diagnostics.find(
        (d) => d.ruleId === 'starter-v0/agents/missing-boundaries',
      ),
    ).toBeUndefined();
  });

  it('INT-LINT-03 nested per-plugin AGENTS.md gets linted too', async () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'plugins', 'gateway-policy'), { recursive: true });
    // Plugin's AGENTS.md is missing `## Boundaries`.
    writeFileSync(
      join(ws, 'plugins', 'gateway-policy', 'AGENTS.md'),
      '## Tools\n- gh\n',
      'utf-8',
    );

    const manifest = await buildWorkspaceManifest(ws);
    const files = manifest.entries.map(manifestEntryToLintFile);

    expect(files.length).toBe(1);
    const result = runLint({ rules: STARTER_RULES_V0, files });
    expect(
      result.diagnostics.find(
        (d) => d.ruleId === 'starter-v0/agents/missing-boundaries',
      ),
    ).toBeDefined();
  });

  it('INT-LINT-04 manifest byKind summary lets hosts skip empty parsers', async () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'AGENTS.md'), '## Tools\n## Boundaries\n', 'utf-8');

    const manifest = await buildWorkspaceManifest(ws);
    expect(manifest.byKind).toEqual({ md: 1, jsonc: 0, jsonl: 0, yaml: 0 });

    // A host that only loaded the md parser is fine — manifest says
    // there are no jsonc/jsonl/yaml files anyway.
  });
});
