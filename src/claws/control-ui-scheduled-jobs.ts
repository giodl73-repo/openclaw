import type { ClawScheduledJobDisclosure } from "../../packages/gateway-protocol/src/schema/claws.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  type PersistedClawCronRef,
} from "./cron.js";
import { digestClawValue } from "./digest.js";
import { cronJobSchema } from "./schema.js";
import type { ClawAddPlanAction, ClawCronJob } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

type ScheduledRow = ClawScheduledJobDisclosure["jobs"][number];
type SafeDeclaration = NonNullable<ScheduledRow["proposed"]>;

function projectDeclaration(agentId: string, job: ClawCronJob): SafeDeclaration {
  // Reuse the Claw creation adapter's delivery default, not generic cron defaults.
  const input = clawCronGatewayInput(agentId, { job, declarationKey: "" });
  return {
    schedule: { cron: job.schedule.cron, timezone: job.schedule.timezone },
    session: job.session,
    delivery: input.delivery.mode === "announce" ? "last-channel" : "none",
  };
}

export function buildClawAddScheduledJobs(plan: {
  agent: { finalId: string };
  actions: readonly ClawAddPlanAction[];
}): ClawScheduledJobDisclosure {
  return {
    coverage: "package-declarations",
    jobs: plan.actions
      .filter((action) => action.kind === "cronJob")
      .map((action) => {
        const details = action.details;
        // Add actions also carry planner metadata; validate only the declaration fields.
        const parsed = cronJobSchema.safeParse({
          id: details?.id,
          name: details?.name,
          schedule: details?.schedule,
          session: details?.session,
          message: details?.message,
          delivery: details?.delivery,
        });
        if (!parsed.success || parsed.data.id !== action.id || action.action !== "schedule") {
          throw new Error("Claw scheduled declaration preview is unavailable.");
        }
        return {
          id: action.id,
          action: action.action,
          blocked: action.blocked,
          proposed: projectDeclaration(plan.agent.finalId, parsed.data),
        };
      }),
  };
}

function isRecordedStatus(status: PersistedClawCronRef["status"]): boolean {
  return ["pending", "complete", "failed", "removed"].includes(status);
}

export function buildClawUpdateScheduledJobs(params: {
  plan: Pick<ClawUpdatePlan, "agentId" | "actions">;
  proposed: readonly ClawCronJob[];
  recorded: readonly PersistedClawCronRef[];
}): ClawScheduledJobDisclosure {
  const { plan } = params;
  const recorded = params.recorded.filter((ref) => ref.agentId === plan.agentId);
  return {
    coverage: "package-declarations",
    jobs: plan.actions
      .filter((action) => action.kind === "cronJob")
      .map((action) => {
        const row: ScheduledRow = {
          id: action.id,
          action: action.action,
          blocked: action.blocked,
        };
        const targets = params.proposed.filter((job) => job.id === action.id);
        if (targets.length) {
          const parsed = cronJobSchema.safeParse(targets[0]);
          if (
            targets.length !== 1 ||
            !parsed.success ||
            action.desiredDigest !== digestClawValue(targets[0])
          ) {
            throw new Error("Claw scheduled declaration preview is unavailable.");
          }
          row.proposed = projectDeclaration(plan.agentId, parsed.data);
        } else if (
          action.desiredDigest ||
          action.action === "add" ||
          action.action === "change" ||
          action.action === "unchanged"
        ) {
          throw new Error("Claw scheduled declaration preview is unavailable.");
        }

        const refs = recorded.filter((ref) => ref.manifestId === action.id);
        if (refs.length || action.action !== "add" || action.currentDigest) {
          row.recorded = { state: "unresolved" };
          const ref = refs[0];
          const parsed = cronJobSchema.safeParse(ref?.job);
          if (
            refs.length === 1 &&
            ref &&
            ref.schemaVersion === CLAW_CRON_REF_SCHEMA_VERSION &&
            isRecordedStatus(ref.status) &&
            (ref.schedulerJobId === undefined || typeof ref.schedulerJobId === "string") &&
            ref.declarationKey === `claw:${plan.agentId}:${action.id}` &&
            parsed.success &&
            parsed.data.id === action.id &&
            action.currentDigest === digestClawValue(ref.job)
          ) {
            row.recorded = {
              state: "declared",
              job: projectDeclaration(plan.agentId, parsed.data),
              status: ref.status,
              schedulerIdRecorded: Boolean(ref.schedulerJobId),
            };
          }
        }
        return row;
      }),
  };
}
