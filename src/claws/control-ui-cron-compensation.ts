import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { createCronMutationCompletion } from "../cron/mutation-completion.js";
import type { CronService } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type {
  ClawControlUiCronMutationParams,
  ClawControlUiCronMutationResult,
} from "./control-ui-worker-contract.js";
import { clawCronGatewayJobMatchesRef } from "./cron.js";

type CronOwner = Pick<CronService, "list" | "getLoadedJobs" | "add" | "remove">;
type JobIdentity = { id: string; configRevision: string; updatedAtMs: number };

function identity(job: CronJob): JobIdentity {
  return {
    id: job.id,
    configRevision: resolveCronJobConfigRevision(job),
    updatedAtMs: job.updatedAtMs,
  };
}

/** Private, task-scoped custody. The worker can consume an inverse, never author one. */
export function createClawControlUiCronCompensation(options: {
  cron: CronOwner;
  assertCurrent: () => void;
  assertOwnerCurrent: () => void;
  invoke: (
    method: string,
    params: Record<string, unknown>,
    guard: () => void,
    isCommitted: () => boolean,
  ) => Promise<unknown>;
}) {
  const receipts = new Map<string, () => Promise<unknown>>();

  const mutate = async (
    params: ClawControlUiCronMutationParams,
  ): Promise<ClawControlUiCronMutationResult> => {
    options.assertCurrent();
    const { cron } = options;
    const jobs = await cron.list({ includeDisabled: true });
    options.assertCurrent();
    const previousRef = params.previous;
    const declarationKey =
      params.operation === "add" ? params.input.declarationKey : params.previous.declarationKey;
    const agentId = params.operation === "add" ? params.input.agentId : params.previous.agentId;
    if (
      typeof declarationKey !== "string" ||
      typeof agentId !== "string" ||
      !declarationKey.startsWith(`claw:${agentId}:`)
    ) {
      throw new Error("Claw cron compensation requires an owned declaration.");
    }
    const matches = (job: CronJob) => job.declarationKey === declarationKey;
    const existing = jobs.filter(matches);
    if (existing.length > 1) {
      throw new Error("Claw cron declaration is ambiguous.");
    }
    const previous = existing[0] ? structuredClone(existing[0]) : undefined;
    if (
      previousRef
        ? !previous ||
          previous.id !== previousRef.schedulerJobId ||
          !clawCronGatewayJobMatchesRef(agentId, previousRef, cronJobReadView(previous))
        : previous !== undefined
    ) {
      throw new Error("Claw cron declaration changed after planning.");
    }
    if (params.operation === "remove" && params.id !== previous?.id) {
      throw new Error("Claw cron removal no longer names its owned scheduler job.");
    }

    const admission = captureOpenClawStateReadContext().admission;
    const assertOwner = () => {
      options.assertOwnerCurrent();
      admission.assertCurrent();
    };
    const assertIdentity = (expected: JobIdentity | undefined) => {
      assertOwner();
      const current = cron.getLoadedJobs()?.filter(matches);
      if (!current) {
        throw new Error("Claw cron scheduler is no longer loaded.");
      }
      const job = current[0];
      if (
        expected
          ? current.length !== 1 ||
            !job ||
            job.id !== expected.id ||
            job.updatedAtMs !== expected.updatedAtMs ||
            resolveCronJobConfigRevision(job) !== expected.configRevision
          : current.length !== 0
      ) {
        throw new Error("Claw cron scheduler ownership changed before compensation.");
      }
    };
    const method = params.operation === "add" ? "cron.add" : "cron.remove";
    let result: unknown;
    let committed: JobIdentity | undefined;
    let captured = false;
    const captureResult = (value: unknown) => {
      if (params.operation === "add") {
        const job = isRecord(value) && isRecord(value.job) ? value.job : value;
        if (
          !isRecord(job) ||
          typeof job.id !== "string" ||
          typeof job.configRevision !== "string" ||
          typeof job.updatedAtMs !== "number"
        ) {
          throw new Error("Claw cron mutation returned no committed scheduler identity.");
        }
        committed = {
          id: job.id,
          configRevision: job.configRevision,
          updatedAtMs: job.updatedAtMs,
        };
      } else if (!isRecord(value) || value.removed !== true) {
        throw new Error("Claw cron removal did not complete.");
      }
      result = value;
      captured = true;
    };
    const completion = createCronMutationCompletion(method, () => {
      // This callback runs synchronously in the scheduler's committed publication,
      // before logging, cancellation or response delivery can throw or yield.
      const current = cron.getLoadedJobs()?.filter(matches);
      const job = current?.[0];
      if (params.operation === "add" && current?.length === 1 && job) {
        captureResult(cronJobReadView(job));
      } else if (params.operation === "remove" && current?.length === 0) {
        captureResult({ ok: true, removed: true });
      }
    })!;
    try {
      const response = await completion.run(() =>
        options.invoke(
          method,
          params.operation === "add" ? params.input : { id: params.id },
          () => {
            // Scheduler-owned postcommit cancellation settles the already accepted removal.
            assertOwner();
            if (!completion.isCommitted()) {
              options.assertCurrent();
              assertIdentity(previous ? identity(previous) : undefined);
            }
          },
          completion.isCommitted,
        ),
      );
      // Declaration convergence can be a successful no-op with no commit notification.
      if (!captured) {
        captureResult(response);
      }
    } catch (error) {
      if (!completion.isCommitted() || !captured) {
        throw error;
      }
    }

    const compensationId = randomUUID();
    receipts.set(compensationId, async () => {
      assertIdentity(committed);
      const inverse = createCronMutationCompletion(previous ? "cron.add" : "cron.remove")!;
      const commitGuard = () => {
        assertOwner();
        if (!inverse.isCommitted()) {
          assertIdentity(committed);
        }
      };
      return await inverse.run(async () => {
        if (!previous) {
          if (!committed) {
            throw new Error("Claw cron compensation has no committed target.");
          }
          return await cron.remove(committed.id, { commitGuard });
        }
        // Reuse scheduler convergence and its policy owner, never restore stale run state.
        const {
          id: _id,
          state: _state,
          createdAtMs: _createdAtMs,
          updatedAtMs: _updatedAtMs,
          scheduledToolPolicy,
          ...input
        } = previous;
        return await cron.add(input, {
          enabledExplicit: true,
          scheduledToolPolicy,
          commitGuard,
        });
      });
    });
    return { result, compensationId };
  };

  return {
    mutate,
    async compensate(compensationId: string): Promise<unknown> {
      const rollback = receipts.get(compensationId);
      if (!rollback) {
        throw new Error("Claw cron compensation custody is unavailable or already consumed.");
      }
      // Unknown outcomes are not replayed, and concurrent requests cannot reuse custody.
      receipts.delete(compensationId);
      return await rollback();
    },
  };
}
