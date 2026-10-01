import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateClawLifecycleApplyResult,
  validateClawLifecyclePlanResult,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailResult,
  validateClawsDoctorResult,
  validateClawsStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ClawStatusRecord } from "../../claws/lifecycle-status.js";
const reads = vi.hoisted(() => ({
  inventory: vi.fn(),
  status: vi.fn(),
  detail: vi.fn(),
  addPlan: vi.fn(),
  updatePlan: vi.fn(),
}));
vi.mock("../../claws/inventory-read.js", () => ({ readClawInventory: reads.inventory }));
vi.mock("../../claws/lifecycle-status.js", () => ({ readClawStatus: reads.status }));
vi.mock("../../claws/doctor.js", () => ({ collectInstallFindings: () => [] }));
vi.mock("../../claws/clawhub-source.js", () => ({ readClawHubClawDetail: reads.detail }));
vi.mock("../../claws/control-ui-plan.js", () => ({ planClawAddFromCatalog: reads.addPlan }));
vi.mock("../../claws/control-ui-update-plan.js", () => ({
  planClawUpdateFromCatalog: reads.updatePlan,
}));
import {
  listCoreAdvertisedGatewayMethodNames,
  resolveCoreOperatorGatewayMethodScope,
} from "../methods/core-method-policy.js";
import { clawsHandlers, projectClawsDoctor, projectClawsStatus } from "./claws.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claw gateway projections", () => {
  it("keeps catalog and lifecycle payloads closed against source or config leakage", () => {
    expect(
      validateClawsCatalogDetailResult({
        schemaVersion: "openclaw.clawsCatalogDetail.v1",
        detail: {
          packageName: "financial-analyst",
          displayName: "Financial Analyst",
          channel: "official",
          official: true,
          version: "1.2.0",
          workspaceFiles: 1,
          skills: 1,
          plugins: 1,
          mcpServers: 1,
          scheduledJobs: 1,
          manifestPath: "/secret/claw.json",
        },
      }),
    ).toBe(false);
    expect(
      validateClawLifecyclePlanResult({
        schemaVersion: "openclaw.clawsGatewayPlan.v1",
        operation: "add",
        planIntegrity: "sha256:preview",
        target: { agentId: "analyst" },
        actions: [],
        capabilities: [],
        blockers: [],
        riskAcknowledgementRequired: false,
        sourceRoot: "/secret/package",
      }),
    ).toBe(false);
    expect(
      validateClawLifecycleApplyResult({
        schemaVersion: "openclaw.clawsGatewayApply.v1",
        operation: "add",
        status: "complete",
        agentId: "analyst",
        message: "Claw agent added.",
      }),
    ).toBe(true);
  });

  it("rejects retired setup answers from schema-v1 lifecycle requests", () => {
    expect(
      validateClawsAddPlanParams({
        source: { packageName: "financial-analyst", version: "1.2.0" },
        answers: { timezone: "America/Los_Angeles" },
      }),
    ).toBe(false);
  });

  it("keeps inventory and ownership while omitting secret-bearing lifecycle fields", async () => {
    const record = {
      install: {
        claw: {
          kind: "package",
          name: "analyst",
          version: "1.0.0",
          packageRoot: "/secret/package",
          manifestPath: "/secret/package/claw.json",
          integrityKind: "artifact",
          integrity: "sha256:secret",
          byteLength: 123,
        },
        agentId: "analyst",
        workspace: "/secret/workspace",
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 2,
      },
      agentState: "present",
      bootstrapState: "complete",
      bootstrap: { state: "complete", workspace: "/secret/workspace", path: "BOOTSTRAP.md" },
      workspaceFiles: [
        {
          path: "SOUL.md",
          sourcePath: "/secret/package/SOUL.md",
          contentDigest: "sha256:file-secret",
          state: "unchanged",
        },
      ],
      packages: [
        {
          kind: "plugin",
          ref: "@openclaw/markets",
          version: "2.0.0",
          integrity: "sha256:plugin-secret",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
          state: "present",
        },
      ],
      mcpServers: [
        {
          name: "markets",
          configDigest: "sha256:mcp-secret",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
          state: "present",
        },
      ],
      cronJobs: [
        {
          manifestId: "morning-brief",
          status: "complete",
          job: { message: "private cron prompt" },
        },
      ],
    } as unknown as ClawStatusRecord;

    const result = projectClawsStatus([record]);
    expect(validateClawsStatusResult(result)).toBe(true);
    expect(result.summary).toMatchObject({ claws: 1, healthy: 1, managed: 4, referenced: 1 });
    expect(result.records[0]?.bootstrapState).toBe("complete");
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin",
          id: "@openclaw/markets@2.0.0",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
        }),
      ]),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/secret/");
    expect(serialized).not.toContain("sha256:");
    expect(serialized).not.toContain("private cron prompt");

    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    for (const [agentOrigin, origin, independentOwner] of [
      ["created", "claw-introduced", false],
      ["adopted", "pre-existing", true],
    ] as const) {
      record.install.agentOrigin = agentOrigin;
      reads.inventory.mockResolvedValueOnce({
        installs: [record.install],
        workspaceFiles: record.workspaceFiles,
        packages: record.packages,
        mcpServers: record.mcpServers,
        cronJobs: record.cronJobs,
      });
      reads.status.mockResolvedValueOnce({ records: [record] });
      const respond = vi.fn();
      await clawsHandlers["claws.status"]!({
        req: { type: "req", id: `status-${agentOrigin}`, method: "claws.status" },
        params: { target: "analyst" },
        respond,
        context: { getRuntimeConfig: () => ({}) } as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        ...result,
        records: [
          {
            ...result.records[0],
            resources: [
              {
                kind: "agent",
                id: "analyst",
                state: "present",
                relationship: "managed",
                origin,
                independentOwner,
              },
              {
                kind: "workspace-file",
                id: "SOUL.md",
                state: "unchanged",
                relationship: "managed",
                origin,
                independentOwner,
              },
              ...result.records[0]!.resources.slice(2),
            ],
          },
        ],
      });
      expect(validateClawsStatusResult(respond.mock.calls[0]?.[1])).toBe(true);
    }

    record.packages[0]!.extensionCompatibility = {
      state: "drifted",
      mapped: [],
      unavailable: ["private-capability"],
    };
    const drifted = projectClawsStatus([record]);
    expect(drifted.summary).toMatchObject({ healthy: 0, attention: 1 });
    expect(
      drifted.records[0]?.resources.find((resource) => resource.kind === "plugin")?.state,
    ).toBe("modified");
    expect(JSON.stringify(drifted)).not.toContain("private-capability");
  });

  it("omits diagnostic targets and source metadata", () => {
    const result = projectClawsDoctor([
      {
        checkId: "core/doctor/claws-state",
        severity: "warning",
        message: "Workspace file changed at /secret/workspace.",
        path: "claws.analyst.workspace.SOUL.md",
        requirement: "Workspace state should match.",
        fixHint: "Inspect the file.",
        target: "/secret/workspace:SOUL.md",
        source: "doctor",
      },
    ]);

    expect(validateClawsDoctorResult(result)).toBe(true);
    expect(result.findings[0]).toEqual({
      severity: "warning",
      message: "Claw-managed workspace file needs attention.",
      path: "claws.analyst.workspace.SOUL.md",
    });
    expect(JSON.stringify(result)).not.toContain("/secret/workspace");
  });
});

describe("Claw gateway feature gate", () => {
  it("rejects direct requests while Claws are disabled", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const calls: Parameters<RespondFn>[] = [];
    const respond: RespondFn = (...args) => calls.push(args);

    await expectDefined(
      clawsHandlers["claws.status"],
      "claws.status handler",
    )({
      req: { type: "req", id: "claws-disabled", method: "claws.status" },
      params: {},
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(false);
    expect(calls[0]?.[2]?.message).toContain("experimental and disabled");
  });
});

describe("Claw registered read methods", () => {
  it("advertises only enabled Claw methods and distinguishes read from apply scope", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    expect(listCoreAdvertisedGatewayMethodNames()).not.toContain("claws.status");
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    expect(listCoreAdvertisedGatewayMethodNames()).toContain("claws.status");
    expect(listCoreAdvertisedGatewayMethodNames()).not.toContain("claws.catalog.search");
    expect(listCoreAdvertisedGatewayMethodNames()).toContain("claws.add.apply");
    expect(clawsHandlers).toHaveProperty("claws.add.apply");
    for (const method of Object.keys(clawsHandlers)) {
      expect(resolveCoreOperatorGatewayMethodScope(method)).toBe(
        method.endsWith(".apply") ? "operator.admin" : "operator.read",
      );
    }
  });

  it("hands the awaited worker inventory to the canonical status owner", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    const inventory = {
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    };
    reads.inventory.mockResolvedValueOnce(inventory);
    reads.status.mockResolvedValueOnce({ records: [] });
    const respond = vi.fn();
    const config = { agents: { entries: {} } };
    await clawsHandlers["claws.status"]!({
      req: { type: "req", id: "status", method: "claws.status" },
      params: { target: "assistant" },
      respond,
      context: { getRuntimeConfig: () => config } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(reads.status).toHaveBeenCalledWith("assistant", { config, readOnly: true, inventory });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ summary: expect.objectContaining({ claws: 0 }) }),
    );
  });

  it("does not return private source errors to clients", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    reads.detail.mockRejectedValueOnce(
      new Error("token=private-fixture /private/path preview it again"),
    );
    const respond = vi.fn();
    await clawsHandlers["claws.catalog.detail"]!({
      req: { type: "req", id: "detail", method: "claws.catalog.detail" },
      params: { packageName: "@owner/assistant" },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(respond.mock.calls)).not.toContain("private");
  });

  it("dispatches an exact add preview without accepting client-owned plans", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    reads.addPlan.mockResolvedValueOnce({ planIntegrity: "sha256:preview" });
    const params = { source: { packageName: "@owner/assistant", version: "1.2.3" } };
    const respond = vi.fn();
    const request = {
      req: { type: "req" as const, id: "preview", method: "claws.add.plan" },
      params,
      respond,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    };
    await clawsHandlers["claws.add.plan"]!(request);
    expect(reads.addPlan).toHaveBeenCalledWith({
      ...params,
      getRuntimeConfig: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(true, { planIntegrity: "sha256:preview" });
    reads.addPlan.mockClear();
    await clawsHandlers["claws.add.plan"]!({
      ...request,
      params: { ...params, plan: { actions: [] } },
    });
    expect(reads.addPlan).not.toHaveBeenCalled();
  });

  it("wires update preview to the canonical adapter", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    reads.updatePlan.mockResolvedValueOnce({ planIntegrity: "sha256:update" });
    const params = {
      target: "assistant",
      source: { packageName: "@owner/assistant", version: "1.2.3" },
    };
    const respond = vi.fn();
    await clawsHandlers["claws.update.plan"]!({
      req: { type: "req", id: "update", method: "claws.update.plan" },
      params,
      respond,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(reads.updatePlan).toHaveBeenCalledWith({
      ...params,
      getRuntimeConfig: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(true, { planIntegrity: "sha256:update" });
  });
});
