import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ControlUiPolicySettingsConstraint } from "../control-ui-contract.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type PolicySettingsConstraintViolation = {
  path: string;
  constraint: ControlUiPolicySettingsConstraint;
  value: unknown;
};

function formatConfigPolicyPath(parentPath: string, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function matchesConstraintPath(pattern: string, path: string): boolean {
  const patternParts = pattern.split(".");
  const pathParts = path.split(".");
  if (patternParts.length !== pathParts.length) {
    return false;
  }
  return patternParts.every((part, index) => part === "*" || part === pathParts[index]);
}

function pathsIntersect(pattern: string, path: string): boolean {
  return matchesConstraintPath(pattern, path) || path === pattern || pattern.startsWith(`${path}.`);
}

function collectConstraintCandidateValues(params: {
  value: unknown;
  changedPath: string;
  constraintPath: string;
}): Array<{ path: string; value: unknown }> {
  if (params.changedPath !== "" && !pathsIntersect(params.constraintPath, params.changedPath)) {
    return [];
  }
  if (matchesConstraintPath(params.constraintPath, params.changedPath)) {
    return [{ path: params.changedPath, value: params.value }];
  }
  if (params.value === null || typeof params.value !== "object" || Array.isArray(params.value)) {
    return [];
  }
  return Object.entries(params.value).flatMap(([key, value]) =>
    collectConstraintCandidateValues({
      value,
      changedPath: formatConfigPolicyPath(params.changedPath, key),
      constraintPath: params.constraintPath,
    }),
  );
}

function violatesConstraint(
  value: unknown,
  constraint: ControlUiPolicySettingsConstraint,
): boolean {
  if (constraint.state === "disabled") {
    return true;
  }
  if (
    constraint.state === "readOnly" &&
    constraint.allowedValues === undefined &&
    constraint.deniedValues === undefined
  ) {
    return true;
  }
  if (
    constraint.allowedValues !== undefined &&
    !constraint.allowedValues.some((allowed) => isDeepStrictEqual(value, allowed))
  ) {
    return true;
  }
  return constraint.deniedValues?.some((denied) => isDeepStrictEqual(value, denied)) ?? false;
}

function summarizePolicySettingsViolation(violation: PolicySettingsConstraintViolation): string {
  return (
    `config write rejected by active policy at ${violation.path}: ` + violation.constraint.reason
  );
}

async function resolvePolicySettingsConstraints(context?: GatewayRequestContext) {
  return await context?.getPolicySettingsConstraints?.();
}

export async function rejectPolicySettingsConstraintViolations(params: {
  context?: GatewayRequestContext;
  nextConfig: unknown;
  changedPaths: readonly string[];
  respond: RespondFn;
}): Promise<boolean> {
  const constraints = await resolvePolicySettingsConstraints(params.context);
  if (!constraints || constraints.mode !== "active-policy-constraints") {
    return false;
  }
  const violations: PolicySettingsConstraintViolation[] = [];
  for (const changedPath of params.changedPaths) {
    const candidates = collectConstraintCandidateValues({
      value: params.nextConfig,
      changedPath: "",
      constraintPath: changedPath,
    });
    for (const constraint of Object.values(constraints.settings)) {
      for (const candidate of candidates) {
        if (
          pathsIntersect(constraint.path, candidate.path) &&
          violatesConstraint(candidate.value, constraint)
        ) {
          violations.push({ path: candidate.path, value: candidate.value, constraint });
        }
      }
    }
  }
  const violation = violations[0];
  if (!violation) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, summarizePolicySettingsViolation(violation), {
      details: {
        policySettingsConstraint: {
          path: violation.path,
          policyPath: violation.constraint.policyPath,
          source: violation.constraint.source,
          broker: violation.constraint.broker,
          checkId: violation.constraint.checkId,
          state: violation.constraint.state,
        },
      },
    }),
  );
  return true;
}
