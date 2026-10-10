import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertLegacyOperatorGatewayState,
  seedLegacyOperatorDefaultCron,
  seedLegacyOperatorGatewayState,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
const originalChildProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const dirs = useAutoCleanupTempDirTracker(afterEach);
const jobs = [
  { id: "main-job", name: "survivor-default-owner", effectiveAgentId: "main" },
  { id: "ops-job", name: "survivor-ops-owner", agentId: "ops", effectiveAgentId: "ops" },
];
const marker = (agentId: string) => `OPENCLAW_E2E_LEGACY_OPERATOR_CRON_${agentId.toUpperCase()}`;
const entries = jobs.map((job, index) => ({
  jobId: job.id,
  action: "finished",
  ts: 200 + index,
  runAtMs: 100 + index,
  runId: `published-run-${index}`,
  status: "ok",
  summary: marker(job.effectiveAgentId),
  sessionId: `retained-session-${index}`,
  sessionKey: `agent:${job.effectiveAgentId}:cron:${job.id}:run:retained-session-${index}`,
}));
const commandEntry = {
  jobId: jobs[1].id,
  action: "finished",
  ts: 201,
  runAtMs: 101,
  runId: "published-run-1",
  status: "error",
  completionStatus: "failed",
  error: "command exited with code 7",
  summary: "survivor-stable-failure",
  diagnostics: {
    entries: [
      {
        ts: 200,
        source: "exec",
        severity: "error",
        message: "command error: survivor-stable-failure",
        exitCode: 7,
        truncated: false,
      },
    ],
  },
};
const settledJobs = jobs.map((job, index) => ({
  ...job,
  enabled: false,
  schedule: { kind: "every", everyMs: 86_400_000 },
  payload:
    index === 0
      ? { kind: "agentTurn", message: `Reply with exactly ${marker("main")}.` }
      : { kind: "command", argv: ["sh", "-lc", "printf survivor-stable-failure >&2; exit 7"] },
  state: { lastRunStatus: index === 0 ? "ok" : "error" },
}));
const page = (values: unknown[], total = values.length, offset = 0) => ({
  entries: values,
  total,
  offset,
  limit: 1,
  hasMore: false,
  nextOffset: null,
});
const reply = (value: unknown) => ({
  pid: 1,
  output: [],
  status: 0,
  signal: null,
  stdout: JSON.stringify(value),
  stderr: "",
});
beforeEach(() => {
  vi.mocked(spawnSync).mockReset().mockImplementation(originalChildProcess.spawnSync);
});
afterEach(() => {
  vi.mocked(spawnSync).mockImplementation(originalChildProcess.spawnSync);
});

it.each([
  { version: "2026.9.4", damage: "none" },
  { version: "2026.9.6", damage: "none" },
  { version: "2026.9.9", damage: "none" },
  ...[
    "cli-failed",
    "wrong-cli-exit",
    "wrong-run",
    "incomplete",
    "wrong-exit",
    "empty-diagnostics",
    "new-code",
    "unfinished",
    "running",
  ].map((damage) => ({ version: "2026.9.9", damage })),
])("seeds native run rows only through the $version CLI ($damage)", async ({ version, damage }) => {
  const root = dirs.make("survivor-cron-reader-seed-");
  const baselinePath = path.join(root, "legacy-operator-baseline.json");
  fs.writeFileSync(baselinePath, "{}");
  const ran = new Set<string>();
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (command !== "openclaw") {
      return originalChildProcess.spawnSync(command, args, options);
    }
    if (!Array.isArray(args)) {
      throw new Error("CLI arguments missing");
    }
    if (args[1] === "add") {
      const job = jobs.find((candidate) => candidate.name === args[args.indexOf("--name") + 1])!;
      const failedCommand = version === "2026.9.9" && job.agentId === "ops";
      const agentRun = version !== "2026.9.4" && !failedCommand;
      expect(args.includes("--no-deliver")).toBe(agentRun);
      if (agentRun) {
        expect(args[args.indexOf("--message") + 1]).toBe(
          `Reply with exactly ${marker(job.effectiveAgentId)}.`,
        );
        expect(args).not.toContain("--command");
      } else {
        expect(args[args.indexOf("--command") + 1]).toBe(
          failedCommand ? "printf survivor-stable-failure >&2; exit 7" : "printf survivor-cron",
        );
        expect(args).not.toContain("--message");
      }
      return reply(job);
    }
    if (args[1] === "run") {
      expect(args).toEqual(["cron", "run", args[2], "--wait"]);
      ran.add(args[2]);
      const job = jobs.find((candidate) => candidate.id === args[2])!;
      if (version === "2026.9.9" && job.agentId === "ops") {
        return {
          ...reply(
            damage === "cli-failed"
              ? { ok: false, error: "Gateway unavailable" }
              : {
                  ok: true,
                  enqueued: true,
                  completed: damage !== "incomplete",
                  status: "error",
                  completionStatus: "failed",
                  runId: damage === "wrong-run" ? "another-run" : commandEntry.runId,
                  run: commandEntry,
                },
          ),
          status: damage === "wrong-cli-exit" ? 0 : 1,
        };
      }
      fs.appendFileSync(
        path.join(root, "legacy-operator-requests.jsonl"),
        JSON.stringify({
          method: "POST",
          path: "/v1/chat/completions",
          body: { message: marker(job.effectiveAgentId) },
        }) + "\n",
      );
      return reply({ ok: true });
    }
    if (args[1] === "list") {
      return reply({
        jobs: settledJobs.map((job) =>
          damage === "running" && job.agentId === "ops"
            ? { ...job, state: { ...job.state, runningAtMs: 100 } }
            : job,
        ),
      });
    }
    expect(args[1]).toBe("runs");
    const id = args[args.indexOf("--id") + 1];
    expect(ran.has(id)).toBe(true);
    if (version === "2026.9.9" && id === "ops-job") {
      const entry = structuredClone(commandEntry);
      if (damage === "wrong-exit") {
        entry.diagnostics.entries[0].exitCode = 1;
      } else if (damage === "empty-diagnostics") {
        entry.diagnostics.entries = [];
      } else if (damage === "new-code") {
        Object.assign(entry.diagnostics.entries[0], { code: "SYSTEM_RUN_DENIED" });
      } else if (damage === "unfinished") {
        entry.action = "started";
      }
      return reply(page([entry]));
    }
    return reply(page(entries.filter((entry) => entry.jobId === id)));
  });
  await withEnvAsync(
    {
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: version,
    },
    async () => {
      seedLegacyOperatorDefaultCron();
      if (damage === "none") {
        seedLegacyOperatorGatewayState();
      } else {
        expect(() => seedLegacyOperatorGatewayState()).toThrow();
      }
    },
  );
  const saved = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (damage !== "none") {
    expect(saved.jobs).toHaveLength(1);
    return;
  }
  expect(saved.jobs).toHaveLength(2);
  if (version === "2026.9.9") {
    expect([...ran]).toEqual(["main-job", "ops-job"]);
    expect(saved.jobs.flatMap((job: { history: unknown[] }) => job.history)).toEqual([
      entries[0],
      commandEntry,
    ]);
    expect(saved.jobs.map((job: { settledJob: unknown }) => job.settledJob)).toEqual(settledJobs);
    expect(saved.jobs[1].transcriptMarker).toBeUndefined();
  } else if (version === "2026.9.6") {
    expect([...ran]).toEqual(["main-job", "ops-job"]);
    expect(saved.jobs.flatMap((job: { history: unknown[] }) => job.history)).toEqual(entries);
    expect(saved.jobs.map((job: { transcriptMarker: string }) => job.transcriptMarker)).toEqual(
      jobs.map((job) => marker(job.effectiveAgentId)),
    );
  } else {
    expect([...ran]).toEqual([]);
    expect(saved.jobs.every((job: { history?: unknown[] }) => job.history === undefined)).toBe(
      true,
    );
  }
});

it.each([
  { source: "native", damage: "none" },
  { source: "legacy", damage: "none" },
  { source: "native", damage: "content" },
  { source: "legacy", damage: "missing-filter" },
  { source: "native", damage: "offset" },
  { source: "native", damage: "transcript-duplicate" },
  { source: "native", damage: "transcript-other-run" },
  { source: "native", damage: "transcript-other-prompt-run" },
  { source: "native", damage: "transcript-missing-cursor" },
  { source: "native-command", damage: "none" },
  { source: "native-command", damage: "exit-code" },
  { source: "native-command", damage: "new-code" },
  { source: "native-command", damage: "empty-diagnostics" },
  { source: "native-command", damage: "job-payload" },
])("checks candidate Cron pages for $source history ($damage)", async ({ source, damage }) => {
  const root = dirs.make("survivor-cron-reader-check-");
  const native = source !== "legacy";
  const observedEntries = source === "native-command" ? [entries[0], commandEntry] : entries;
  fs.writeFileSync(
    path.join(root, "legacy-operator-baseline.json"),
    JSON.stringify({
      jobs: jobs.map((job, index) => ({
        ...job,
        ...(native
          ? {
              history: [observedEntries[index]],
              ...(source === "native-command"
                ? {
                    settledJob: settledJobs[index],
                    ...(index === 0 ? { transcriptMarker: marker(job.effectiveAgentId) } : {}),
                  }
                : { transcriptMarker: marker(job.effectiveAgentId) }),
            }
          : {}),
      })),
    }),
  );
  const contract = "candidate-doctor-import";
  if (!native) {
    fs.writeFileSync(
      path.join(root, "legacy-operator-cron-history.json"),
      JSON.stringify({ entries }),
    );
    fs.writeFileSync(
      path.join(root, "legacy-operator-cron-history-proof.json"),
      JSON.stringify({ status: "passed", contract }),
    );
  }
  const transcriptRequests: unknown[] = [];
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (command !== "openclaw") {
      return originalChildProcess.spawnSync(command, args, options);
    }
    if (!Array.isArray(args)) {
      throw new Error("CLI arguments missing");
    }
    if (args[1] === "list") {
      return reply({
        jobs:
          source === "native-command"
            ? settledJobs.map((job) =>
                damage === "job-payload" && job.agentId === "ops"
                  ? { ...job, payload: { kind: "command", argv: ["true"] } }
                  : job,
              )
            : jobs,
      });
    }
    if (args[0] === "gateway") {
      expect(args.slice(0, 5)).toEqual([
        "gateway",
        "call",
        "cron.history",
        "--expect-url",
        "ws://127.0.0.1:18789",
      ]);
      const request = JSON.parse(args[args.indexOf("--params") + 1]);
      const index = jobs.findIndex((job) => job.id === request.id);
      const job = jobs[index];
      const entry = entries[index];
      assert(job && entry, "unexpected Cron transcript fixture identity");
      expect(request).toEqual({
        id: job.id,
        runId: entry.runId,
        limit: 1,
        ...(request.cursor ? { cursor: `earlier-${index}` } : {}),
      });
      transcriptRequests.push(request);
      const transcriptMarker = marker(job.effectiveAgentId);
      return reply({
        messages: [
          {
            role: "assistant",
            content: request.cursor
              ? `Reply with exactly ${transcriptMarker}.`
              : damage === "transcript-other-run"
                ? "another run"
                : transcriptMarker,
            ...(request.cursor
              ? {
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "cron",
                    jobId: entry.jobId,
                    runId:
                      damage === "transcript-other-prompt-run" ? "another-run" : entry.sessionId,
                    sourceSessionKey: entry.sessionKey,
                  },
                  senderSession: { sessionKey: entry.sessionKey },
                }
              : {}),
            __openclaw: {
              id:
                request.cursor && damage !== "transcript-duplicate"
                  ? `prompt-${index}`
                  : `answer-${index}`,
              seq: request.cursor ? 1 : 2,
              ...(request.cursor ? { turnBoundary: true } : {}),
            },
          },
        ],
        ...(!request.cursor && damage !== "transcript-missing-cursor"
          ? { nextCursor: `earlier-${index}` }
          : {}),
      });
    }
    expect(args.slice(0, 2)).toEqual(["cron", "runs"]);
    const selected = structuredClone(
      observedEntries.filter((entry) => entry.jobId === args[args.indexOf("--id") + 1]),
    );
    if (args.includes("--offset")) {
      return reply(page([], damage === "offset" ? 0 : 1, 1));
    }
    if (args.includes("missing-survivor-run")) {
      return reply(page(damage === "missing-filter" ? selected : []));
    }
    for (const entry of selected) {
      if ("diagnostics" in entry) {
        if (damage === "exit-code") {
          entry.diagnostics.entries[0].exitCode = 0;
        } else if (damage === "new-code") {
          Object.assign(entry.diagnostics.entries[0], { code: "SYSTEM_RUN_DENIED" });
        } else if (damage === "empty-diagnostics") {
          entry.diagnostics.entries = [];
        }
      }
    }
    return reply(
      page(
        damage === "content"
          ? selected.map((entry) => ({ ...entry, summary: "changed" }))
          : selected,
      ),
    );
  });
  await withEnvAsync({ OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root }, async () => {
    if (damage === "none") {
      expect(() => assertLegacyOperatorGatewayState("candidate")).not.toThrow();
    } else {
      expect(() => assertLegacyOperatorGatewayState("candidate")).toThrow();
    }
  });
  if (damage === "job-payload") {
    expect(fs.existsSync(path.join(root, "legacy-operator-candidate-cron-history.json"))).toBe(
      false,
    );
    return;
  }
  const proof = JSON.parse(
    fs.readFileSync(path.join(root, "legacy-operator-candidate-cron-history.json"), "utf8"),
  );
  expect(proof.status).toBe(damage === "none" ? "passed" : "failed");
  expect(proof.source).toBe(native ? "published-native-runs" : contract);
  if (damage === "none") {
    expect(proof.pages).toHaveLength(2);
    expect(transcriptRequests).toHaveLength(source === "native-command" ? 2 : native ? 4 : 0);
    if (source === "native") {
      for (const [index, transcriptProof] of proof.pages.entries()) {
        const job = jobs[index];
        const entry = entries[index];
        assert(job && entry, "unexpected Cron transcript proof identity");
        expect(transcriptProof.transcript).toMatchObject({
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
          recent: {
            messages: [{ role: "assistant", content: marker(job.effectiveAgentId) }],
          },
          earlier: {
            messages: [
              {
                role: "assistant",
                content: `Reply with exactly ${marker(job.effectiveAgentId)}.`,
              },
            ],
          },
        });
      }
    }
  }
});
