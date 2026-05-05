import { parseYaml } from '@openclaw/oc-path';
import { describe, expect, it } from 'vitest';
import {
  lobsterYamlStarterRules,
  stepDuplicateId,
  stepMutuallyExclusiveBody,
  stepShellToolCollision,
  stepUndefinedStdinRef,
} from '../../../src/extensions/oclint-rules-lobster-yaml-starter/index.js';

function ctx(raw: string, fileName = 'inbox-triage.lobster') {
  return { fileName, ast: parseYaml(raw).ast };
}

describe('lobster-yaml — step/shell-tool-collision (issues #25, #26, #41)', () => {
  it('flags `command: openclaw.invoke ...`', () => {
    const f = stepShellToolCollision.check(
      ctx('steps:\n  - id: a\n    command: openclaw.invoke --tool foo\n'),
    );
    expect(f.length).toBe(1);
    expect(f[0]?.message).toContain('openclaw.invoke');
    expect(f[0]?.ocPath).toBe('oc://inbox-triage.lobster/steps/0/command');
  });

  it('flags `run: llm_task.invoke ...`', () => {
    const f = stepShellToolCollision.check(
      ctx('steps:\n  - id: a\n    run: llm_task.invoke ...\n'),
    );
    expect(f.length).toBe(1);
  });

  it('passes `command: gh issue list` (real shell command)', () => {
    expect(
      stepShellToolCollision.check(
        ctx('steps:\n  - id: a\n    command: gh issue list\n'),
      ).length,
    ).toBe(0);
  });

  it('passes `pipeline: openclaw.invoke ...` (correct surface)', () => {
    expect(
      stepShellToolCollision.check(
        ctx('steps:\n  - id: a\n    pipeline: openclaw.invoke --tool foo\n'),
      ).length,
    ).toBe(0);
  });

  it('flags every offending step in a multi-step workflow', () => {
    const raw =
      'steps:\n' +
      '  - id: a\n    command: openclaw.invoke ...\n' +
      '  - id: b\n    command: ls\n' +
      '  - id: c\n    command: llm.invoke ...\n';
    expect(stepShellToolCollision.check(ctx(raw)).length).toBe(2);
  });
});

describe('lobster-yaml — step/mutually-exclusive-body (issue #41)', () => {
  it('flags command + pipeline on same step', () => {
    const f = stepMutuallyExclusiveBody.check(
      ctx('steps:\n  - id: a\n    command: ls\n    pipeline: openclaw.invoke ...\n'),
    );
    expect(f.length).toBe(1);
    expect(f[0]?.message).toContain('command, pipeline');
  });

  it('flags run + pipeline', () => {
    const f = stepMutuallyExclusiveBody.check(
      ctx('steps:\n  - id: a\n    run: ls\n    pipeline: foo\n'),
    );
    expect(f.length).toBe(1);
  });

  it('passes a step with only one body field', () => {
    expect(
      stepMutuallyExclusiveBody.check(
        ctx('steps:\n  - id: a\n    command: ls\n'),
      ).length,
    ).toBe(0);
  });
});

describe('lobster-yaml — step/duplicate-id (issues #76, #77)', () => {
  it('flags collision', () => {
    const f = stepDuplicateId.check(
      ctx('steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n'),
    );
    expect(f.length).toBe(1);
    expect(f[0]?.message).toContain('collides');
  });

  it('passes unique ids', () => {
    expect(
      stepDuplicateId.check(
        ctx('steps:\n  - id: a\n    command: x\n  - id: b\n    command: y\n'),
      ).length,
    ).toBe(0);
  });

  it('flags multiple collisions independently', () => {
    const f = stepDuplicateId.check(
      ctx(
        'steps:\n  - id: a\n    command: x\n  - id: a\n    command: y\n  - id: b\n    command: z\n  - id: b\n    command: w\n',
      ),
    );
    expect(f.length).toBe(2);
  });
});

describe('lobster-yaml — step/undefined-stdin-ref (issue #41)', () => {
  it('flags `stdin: $unknown.stdout`', () => {
    const f = stepUndefinedStdinRef.check(
      ctx('steps:\n  - id: a\n    command: x\n    stdin: $missing.stdout\n'),
    );
    expect(f.length).toBe(1);
    expect(f[0]?.message).toContain('missing');
  });

  it('passes `stdin: $earlier.stdout` when earlier step exists', () => {
    expect(
      stepUndefinedStdinRef.check(
        ctx(
          'steps:\n  - id: fetch\n    command: x\n  - id: classify\n    command: y\n    stdin: $fetch.stdout\n',
        ),
      ).length,
    ).toBe(0);
  });

  it('flags forward references (step refs a later step id)', () => {
    const f = stepUndefinedStdinRef.check(
      ctx(
        'steps:\n  - id: a\n    command: x\n    stdin: $b.stdout\n  - id: b\n    command: y\n',
      ),
    );
    expect(f.length).toBe(1);
  });

  it('flags self-reference', () => {
    const f = stepUndefinedStdinRef.check(
      ctx('steps:\n  - id: a\n    command: x\n    stdin: $a.stdout\n'),
    );
    expect(f.length).toBe(1);
  });
});

describe('lobster-yaml — pack invariants', () => {
  it('exports 4 rules', () => {
    expect(lobsterYamlStarterRules).toHaveLength(4);
  });
  it('all rule ids share namespace', () => {
    for (const r of lobsterYamlStarterRules) {
      expect(r.id.startsWith('lobster-yaml-starter-v0/')).toBe(true);
    }
  });
  it('rule ids are unique', () => {
    const ids = lobsterYamlStarterRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('all rules apply to *.lobster', () => {
    for (const r of lobsterYamlStarterRules) {
      expect(r.appliesTo).toBe('*.lobster');
    }
  });
});

describe('lobster-yaml — adversarial inputs do not throw', () => {
  const inputs = [
    '',
    '\n',
    'steps: []\n',
    'steps:\n',
    'steps: not-a-seq\n',
    'unknown: stuff\n',
    'broken yaml [{[}',
    'steps:\n  - {}\n',
    'steps:\n  - command: ls\n', // step without id
  ];
  for (const rule of lobsterYamlStarterRules) {
    for (const raw of inputs) {
      it(`${rule.id} no-throw on ${JSON.stringify(raw.slice(0, 30))}`, () => {
        expect(() => rule.check(ctx(raw))).not.toThrow();
      });
    }
  }
});
