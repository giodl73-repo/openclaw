import { parseYaml } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  stepDedupeId,
  stepSwapShellToPipeline,
  yamlStarterFixers,
} from '../../../src/extensions/ocdoctor-fixers-yaml-starter/index.js';
import type { OcPathFixerSpec } from '../../../src/plugin-sdk/oc-doctor/types.js';

async function detect(spec: OcPathFixerSpec<unknown>, raw: string, fileName = 'wf.lobster') {
  return await spec.detect({ fileName, ast: parseYaml(raw).ast, raw });
}
async function fix(spec: OcPathFixerSpec<unknown>, raw: string, fileName = 'wf.lobster'): Promise<string> {
  const ast = parseYaml(raw).ast;
  const matches = await spec.detect({ fileName, ast, raw });
  if (matches.length === 0) return raw;
  return await spec.fix({
    fileName,
    ast,
    raw,
    match: matches[0]!.match,
  });
}

/** Fan-out helper: re-detect after each fix until no findings remain. */
async function fixAll(spec: OcPathFixerSpec<unknown>, raw: string, fileName = 'wf.lobster'): Promise<string> {
  let next = raw;
  for (let pass = 0; pass < 20; pass++) {
    const ast = parseYaml(next).ast;
    const matches = await spec.detect({ fileName, ast, raw: next });
    if (matches.length === 0) return next;
    next = await spec.fix({ fileName, ast, raw: next, match: matches[0]!.match });
  }
  return next;
}

describe('yaml-starter — step/swap-shell-to-pipeline (issues #25, #26, #41)', () => {
  it('detects `command: openclaw.invoke ...`', async () => {
    expect(
      (await detect(
        stepSwapShellToPipeline,
        'steps:\n  - id: a\n    command: openclaw.invoke --tool foo\n',
      )).length,
    ).toBe(1);
  });

  it('rewrites `command:` to `pipeline:` for in-process tools', async () => {
    const before = 'steps:\n  - id: a\n    command: openclaw.invoke --tool foo\n';
    const after = await fix(stepSwapShellToPipeline, before);
    expect(after).toContain('pipeline: openclaw.invoke');
    expect(after).not.toMatch(/command: openclaw\.invoke/);
  });

  it('rewrites `run:` to `pipeline:` for in-process tools', async () => {
    const before = 'steps:\n  - id: a\n    run: llm_task.invoke ...\n';
    const after = await fix(stepSwapShellToPipeline, before);
    expect(after).toContain('pipeline: llm_task.invoke');
  });

  it('preserves `command:` for real shell commands', async () => {
    const before = 'steps:\n  - id: a\n    command: gh issue list\n';
    const after = await fix(stepSwapShellToPipeline, before);
    expect(after).toContain('command: gh issue list');
  });

  it('is idempotent — second fix is a no-op', async () => {
    const before = 'steps:\n  - id: a\n    command: openclaw.invoke --tool foo\n';
    const once = await fix(stepSwapShellToPipeline, before);
    const twice = await fix(stepSwapShellToPipeline, once);
    expect(twice).toBe(once);
  });

  it('rewrites every offending step in a multi-step workflow (fan-out)', async () => {
    const before =
      'steps:\n' +
      '  - id: a\n    command: openclaw.invoke ...\n' +
      '  - id: b\n    command: ls\n' +
      '  - id: c\n    command: llm.invoke ...\n';
    // Fan-out semantic: detect returns 2 findings, fix runs once per finding.
    const after = await fixAll(stepSwapShellToPipeline, before);
    // step b's command stays (it's a real shell cmd)
    expect(after).toContain('command: ls');
    // both in-process steps rewritten
    expect(after.match(/pipeline:/g)?.length).toBe(2);
  });
});

describe('yaml-starter — step/dedupe-id (issues #76, #77)', () => {
  it('detects collision', async () => {
    expect(
      (await detect(
        stepDedupeId,
        'steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n',
      )).length,
    ).toBe(1);
  });

  it('renames duplicate with index-suffix by default', async () => {
    const before =
      'steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n';
    const after = await fix(stepDedupeId, before);
    // First a stays, second renamed to a_1
    expect(after).toMatch(/id: a_1/);
  });

  it('honors operator-supplied rename-second strategy', async () => {
    const before =
      'steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n';
    const ast = parseYaml(before).ast;
    const matches = await stepDedupeId.detect({ fileName: 'wf.lobster', ast, raw: before });
    const after = await stepDedupeId.fix({
      fileName: 'wf.lobster',
      ast,
      raw: before,
      match: matches[0]!.match,
      options: { strategy: 'rename-second' },
    });
    expect(after).toMatch(/id: a_dupe/);
  });

  it('declares safe defaults', () => {
    expect(stepDedupeId.defaultOptions?.strategy).toBe('index-suffix');
  });

  it('passes a workflow with unique ids', async () => {
    expect(
      (await detect(
        stepDedupeId,
        'steps:\n  - id: a\n    command: x\n  - id: b\n    command: y\n',
      )).length,
    ).toBe(0);
  });

  it('is idempotent — once renamed, no further fix', async () => {
    const before =
      'steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n';
    const once = await fix(stepDedupeId, before);
    const twice = await fix(stepDedupeId, once);
    expect(twice).toBe(once);
  });
});

describe('yaml-starter — pack invariants', () => {
  it('exports 2 fixers', () => {
    expect(yamlStarterFixers).toHaveLength(2);
  });
  it('all use yaml-starter-v0 namespace', () => {
    for (const f of yamlStarterFixers) {
      expect(f.id.startsWith('yaml-starter-v0/')).toBe(true);
    }
  });
  it('all apply to *.lobster', () => {
    for (const f of yamlStarterFixers) {
      expect(f.appliesTo).toBe('*.lobster');
    }
  });
});

describe('yaml-starter — adversarial inputs do not throw', () => {
  const inputs = [
    '',
    'steps: []\n',
    'steps:\n',
    'unknown: stuff\n',
    'broken yaml [{[}',
    'steps:\n  - {}\n',
    'steps:\n  - command: ls\n', // no id
  ];
  for (const fixer of yamlStarterFixers) {
    for (const raw of inputs) {
      it(`${fixer.id} no-throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => fix(fixer, raw)).not.toThrow();
      });
    }
  }
});
