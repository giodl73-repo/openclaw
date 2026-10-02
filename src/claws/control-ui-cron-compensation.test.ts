import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureCronMutationCommit } from "../cron/mutation-completion.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import type { CronService } from "../cron/service.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob } from "../cron/types.js";
import { createClawControlUiHost } from "../gateway/server-methods/claws-mutations.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import { createClawControlUiCronGateway } from "./control-ui-cron-gateway.js";
import type { ClawControlUiHost, ClawControlUiWorkerResult } from "./control-ui-worker-contract.js";
import { runClawControlUiOperation } from "./control-ui-worker.js";
import { applyClawCronUpdate } from "./cron-update.js";
import { clawCronGatewayInput, type PersistedClawCronRef } from "./cron.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import type { ClawManifest } from "./types.js";

const transport = vi.hoisted(() => ({
  run: vi.fn<(request: ClawControlUiHost) => Promise<ClawControlUiWorkerResult>>(),
  admission: vi.fn(),
}));
vi.mock("../state/openclaw-state-worker-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-worker-context.js")>()),
  captureOpenClawStateReadContext: () => ({ admission: { assertCurrent: transport.admission } }),
}));
vi.mock("./control-ui-authority.js", () => ({
  createClawControlUiAuthority: () => ({ port: {}, close: vi.fn() }),
}));
vi.mock("../infra/runtime-worker-url.js", () => ({ resolveRuntimeWorkerUrl: () => "fixture" }));
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: () => ({
    close: vi.fn(),
    runTask: (
      _input: unknown,
      options: {
        onRequest: (value: unknown) => Promise<{ input: { ok: boolean; value?: unknown } }>;
      },
    ) => ({
      close: vi.fn(),
      result: transport.run(async (request) => {
        const reply = await options.onRequest(structuredClone(request));
        if (!reply.input.ok) {
          throw new Error("Claw Gateway operation failed.");
        }
        return structuredClone(reply.input.value);
      }),
    }),
  }),
}));

const previous: PersistedClawCronRef = {
  schemaVersion: "openclaw.clawCronRef.v1",
  agentId: "worker",
  manifestId: "daily",
  declarationKey: "claw:worker:daily",
  schedulerJobId: "scheduler-original",
  status: "complete",
  createdAtMs: 1,
  updatedAtMs: 1,
  job: {
    id: "daily",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    session: "main",
    message: "Original daily",
  },
};
const target: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "worker" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [{ ...previous.job, message: "Updated daily" }],
};
const done: ClawControlUiWorkerResult = {
  schemaVersion: "openclaw.clawsGatewayApply.v1",
  operation: "update",
  status: "partial",
  agentId: "worker",
  message: "Fixture settled.",
};

function fixture(withPrevious = false) {
  let authorized = true;
  let clock = 10;
  const jobs: CronJob[] = [];
  const assertCurrent = () => {
    if (!authorized) {
      throw new Error("Browser revoked.");
    }
  };
  if (withPrevious) {
    const input = expectDefined(
      normalizeCronJobCreate(clawCronGatewayInput("worker", previous)),
      "normalized Claw cron fixture",
    );
    applyDefaultCronToolsAllow(input);
    jobs.push({
      ...input,
      id: previous.schedulerJobId!,
      createdAtMs: 1,
      updatedAtMs: 1,
      state: {},
      scheduledToolPolicy: createTrustedCronScheduledToolPolicy(),
    });
  }
  let beforeCommit = () => {};
  let afterCommit = () => {};
  const cron = {
    getLoadedJobs: () => jobs,
    getJob: (id: string) => jobs.find((job) => job.id === id),
    readJob: async (id: string) => jobs.find((job) => job.id === id),
    getDefaultAgentId: () => "worker",
    list: async () => jobs,
    add: vi.fn<CronService["add"]>(async (input, options) => {
      const existing = jobs.find((job) => job.declarationKey === input.declarationKey);
      const next: CronJob = {
        ...input,
        id: existing?.id ?? `scheduler-${++clock}`,
        createdAtMs: existing?.createdAtMs ?? clock,
        updatedAtMs: ++clock,
        state: existing?.state ?? {},
        scheduledToolPolicy: options?.scheduledToolPolicy,
      };
      applyDefaultCronToolsAllow(next);
      beforeCommit();
      expectDefined(options?.commitGuard, "cron add commit guard")();
      if (existing) {
        jobs.splice(jobs.indexOf(existing), 1, next);
      } else {
        jobs.push(next);
      }
      captureCronMutationCommit("cron.add")?.();
      afterCommit();
      return { created: !existing, updated: Boolean(existing), job: next, ...next };
    }),
    remove: vi.fn<CronService["remove"]>(async (id, options) => {
      beforeCommit();
      expectDefined(options?.commitGuard, "cron remove commit guard")();
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) {
        return { ok: true, removed: false };
      }
      jobs.splice(index, 1);
      captureCronMutationCommit("cron.remove")?.();
      afterCommit();
      // The real scheduler repeats this guard for postcommit active-run cancellation.
      expectDefined(options?.commitGuard, "cron removal settlement guard")();
      return { ok: true, removed: true };
    }),
  };
  const context = {
    cron,
    cronStorePath: "fixture-cron",
    getRuntimeConfig: () => ({ agents: { entries: { worker: {} } } }),
    logGateway: { info: vi.fn() },
  } as unknown as GatewayRequestContext;
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "fixture", method: "claws.update.apply" },
    params: {},
    respond: vi.fn(),
    client: null,
    context,
    isWebchatConnect: () => true,
    hasCurrentClientAuthority: () => authorized,
    sessionMutationCommitGuard: assertCurrent,
  };
  const host = createClawControlUiHost(options, assertCurrent);
  return {
    jobs,
    cron,
    context,
    assertCurrent,
    host,
    revoke: () => {
      authorized = false;
    },
    beforeCommit: (run: () => void) => {
      beforeCommit = run;
    },
    afterCommit: (run: () => void) => {
      afterCommit = run;
    },
    async run(scenario: (request: ClawControlUiHost) => Promise<void>) {
      transport.run.mockImplementationOnce(async (request) => {
        await scenario(request);
        return done;
      });
      await runClawControlUiOperation(
        {
          operation: "update",
          params: {
            target: "worker",
            source: { packageName: "fixture-claw", version: "1.1.0" },
            planIntegrity: "reviewed",
          },
        },
        { assertCurrent, request: host },
      );
    },
  };
}

beforeEach(() => {
  transport.run.mockReset();
  transport.admission.mockReset();
});
afterEach(() => vi.restoreAllMocks());

// Actual request callback + host dispatcher + cron handlers + canonical rollback.
// Only worker/process machinery, database admission and scheduler persistence are fixtures.
describe("Control UI cron compensation across the worker adapter", () => {
  it.each(
    (["add", "change", "remove"] as const).flatMap((action) =>
      (["reply", "postcommit error", "handler error"] as const).map((outcome) => ({
        action,
        outcome,
      })),
    ),
  )(
    "settles $action after browser revocation and $outcome without admitting new work",
    async ({ action, outcome }) => {
      const f = fixture(action !== "add");
      const revoke = () => {
        f.afterCommit(() => {});
        f.revoke();
        if (outcome === "postcommit error") {
          throw new Error("Scheduler settlement failed after commit.");
        }
      };
      f.afterCommit(revoke);
      if (outcome === "handler error") {
        vi.spyOn(f.context.logGateway, "info").mockImplementationOnce(() => {
          throw new Error("Handler response failed after commit.");
        });
      }
      await f.run(async (request) => {
        const gateway = createClawControlUiCronGateway(request);
        gateway.waitUntilAgentAvailable = undefined;
        const upsertRef = vi.fn();
        const deleteRef = vi.fn();
        await expect(
          applyClawCronUpdate(
            createClawUpdatePlanFixture([
              {
                kind: "cronJob",
                id: "daily",
                action,
                target: previous.declarationKey,
                blocked: false,
                reason: "fixture",
              },
            ]),
            target,
            {
              cronGateway: gateway,
              beforePersistentApply: f.assertCurrent,
              readRefs: () => (action === "add" ? [] : [previous]),
              upsertRef,
              deleteRef,
            },
          ),
        ).rejects.toMatchObject({ message: "Browser revoked.", partial: false });
        await expect(gateway.add(clawCronGatewayInput("worker", previous))).rejects.toThrow();
        await expect(gateway.remove("unrelated-job")).rejects.toThrow();
        expect(f.jobs).toHaveLength(action === "add" ? 0 : 1);
        if (action !== "add") {
          expect(f.jobs[0].payload).toMatchObject({ message: "Original daily" });
          expect(upsertRef).toHaveBeenLastCalledWith(
            expect.objectContaining({ schedulerJobId: f.jobs[0].id, status: "complete" }),
            expect.anything(),
          );
        }
      });
    },
  );

  it.each(
    (["add", "change", "remove"] as const).flatMap((action) =>
      (["before rollback", "at commit"] as const).map((when) => ({ action, when })),
    ),
  )("preserves $action replacements $when", async ({ action, when }) => {
    const f = fixture(action !== "add");
    await f.run(async (request) => {
      const gateway = createClawControlUiCronGateway(request);
      const original = f.jobs[0];
      const mutation =
        action === "remove"
          ? await gateway.removeWithRollback!(previous.schedulerJobId!, previous)
          : await gateway.addWithRollback!(
              clawCronGatewayInput("worker", { ...previous, job: target.cronJobs[0] }),
              action === "change" ? previous : undefined,
            );
      const owned = expectDefined(f.jobs[0] ?? original, "owned fixture job");
      f.revoke();
      const replace = () => {
        f.jobs[0] = { ...owned, name: "Replacement", updatedAtMs: 99 };
      };
      if (when === "before rollback") {
        replace();
      } else {
        f.beforeCommit(replace);
      }
      await expect(mutation.rollback()).rejects.toThrow();
      expect(f.jobs).toHaveLength(1);
      expect(f.jobs[0].name).toBe("Replacement");
    });
  });

  it("refuses a forward scheduler commit when browser authority lapses after dispatch", async () => {
    const f = fixture();
    f.beforeCommit(f.revoke);
    await f.run(async (request) => {
      const gateway = createClawControlUiCronGateway(request);
      await expect(
        gateway.addWithRollback!(clawCronGatewayInput("worker", previous)),
      ).rejects.toThrow();
      expect(f.jobs).toEqual([]);
    });
  });

  it("rejects forged, reused and cross-operation receipts after revocation", async () => {
    const f = fixture();
    await f.run(async (request) => {
      const issued = (await request({
        method: "cron.mutate",
        params: {
          operation: "add",
          input: clawCronGatewayInput("worker", previous),
        },
      })) as { compensationId: string };
      const receipt = { compensationId: issued.compensationId };
      const other = fixture();
      f.revoke();
      await expect(other.host({ method: "cron.compensate", params: receipt })).rejects.toThrow();
      await expect(
        request({ method: "cron.compensate", params: { compensationId: "forged" } }),
      ).rejects.toThrow();
      await request({ method: "cron.compensate", params: receipt });
      await expect(request({ method: "cron.compensate", params: receipt })).rejects.toThrow();
      expect(f.jobs).toEqual([]);
    });
  });

  it.each(["scheduler", "database"])(
    "refuses compensation after %s ownership changes",
    async (owner) => {
      const f = fixture();
      await f.run(async (request) => {
        const gateway = createClawControlUiCronGateway(request);
        const mutation = await gateway.addWithRollback!(clawCronGatewayInput("worker", previous));
        f.revoke();
        if (owner === "database") {
          transport.admission.mockImplementation(() => {
            throw new Error("Database replaced.");
          });
        } else {
          f.context.cron = fixture().context.cron;
        }
        await expect(mutation.rollback()).rejects.toThrow();
        expect(f.jobs).toHaveLength(1);
        expect(f.cron.remove).not.toHaveBeenCalled();
      });
    },
  );
});
