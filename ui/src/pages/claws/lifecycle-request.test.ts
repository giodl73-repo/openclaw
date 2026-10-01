import { describe, expect, it } from "vitest";
import { clawPlan } from "./claws.test-support.ts";
import { buildClawApplyRequest, type PendingClawOperation } from "./lifecycle-request.ts";

describe("Claw reviewed requests", () => {
  const add: PendingClawOperation = {
    operation: "add",
    source: { packageName: "@openclaw/travel-concierge", version: "0.2.0" },
    agentId: "travel",
  };
  it("uses the exact reviewed source and integrity", () => {
    expect(buildClawApplyRequest(add, clawPlan(), false)).toEqual({
      method: "claws.add.apply",
      params: { source: add.source, agentId: "travel", planIntegrity: "reviewed-exact-plan" },
    });
  });
  it("requires consent for risk and rejects blockers or a different operation", () => {
    const plan = { ...clawPlan(), riskAcknowledgementRequired: true };
    expect(buildClawApplyRequest(add, plan, false)).toBeNull();
    expect(buildClawApplyRequest(add, plan, true)?.params).toHaveProperty(
      "acknowledgeClawHubRisk",
      true,
    );
    expect(
      buildClawApplyRequest(
        add,
        { ...plan, blockers: [{ code: "unsafe", path: "agent", message: "Blocked" }] },
        true,
      ),
    ).toBeNull();
    expect(
      buildClawApplyRequest(
        add,
        { ...plan, actions: [{ kind: "agent", id: "travel", action: "add", blocked: true }] },
        true,
      ),
    ).toBeNull();
    expect(buildClawApplyRequest(add, clawPlan("remove"), true)).toBeNull();
  });
  it("keeps removal bound to the selected agent without unused-resource deletion", () => {
    expect(
      buildClawApplyRequest(
        { operation: "remove", target: "travel-2", removeUnused: false },
        clawPlan("remove"),
        false,
      ),
    ).toEqual({
      method: "claws.remove.apply",
      params: { target: "travel-2", removeUnused: false, planIntegrity: "reviewed-exact-plan" },
    });
  });
});
