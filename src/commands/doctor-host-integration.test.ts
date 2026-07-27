import { describe, expect, it, vi } from "vitest";
import type { HostIntegrationRuntimeInventoryV1 } from "../plugins/host-integration-runtime-inventory.js";
import {
  collectHostIntegrationHealthFindings,
  hostIntegrationInventoryToHealthFindings,
} from "./doctor-host-integration.js";

type Contribution = HostIntegrationRuntimeInventoryV1["bundles"][number]["contributions"][number];

function contribution(params: {
  id: string;
  status: "True" | "False" | "Unknown";
  reason: string;
  message?: string;
}): Contribution {
  return {
    owner: "secret-owner",
    kind: "service",
    id: params.id,
    contractVersion: "service/v1",
    readiness: {
      type: `criterion.${params.id}`,
      status: params.status,
      reason: params.reason,
      message: params.message ?? "safe status",
    },
  };
}

function inventory(contributions: readonly Contribution[]): HostIntegrationRuntimeInventoryV1 {
  return {
    version: "host-integration-runtime-inventory/v1",
    status: contributions.some((entry) => entry.readiness.status === "False")
      ? "False"
      : contributions.some((entry) => entry.readiness.status === "Unknown")
        ? "Unknown"
        : "True",
    bundles: [
      {
        pluginId: "secret-plugin",
        id: "example-bundle",
        version: "1.2.3",
        status: "Unknown",
        contributions,
      },
    ],
  };
}

describe("hostIntegrationInventoryToHealthFindings", () => {
  it("stays silent without inventory or when every contribution is ready", () => {
    expect(hostIntegrationInventoryToHealthFindings(undefined)).toEqual([]);
    expect(
      hostIntegrationInventoryToHealthFindings(
        inventory([contribution({ id: "ready", status: "True", reason: "Ready" })]),
      ),
    ).toEqual([]);
  });

  it("maps False to error and Unknown to warning in inventory order", () => {
    const findings = hostIntegrationInventoryToHealthFindings(
      inventory([
        contribution({ id: "database", status: "False", reason: "DatabaseUnavailable" }),
        contribution({ id: "queue", status: "Unknown", reason: "QueuePending" }),
      ]),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/host-integration-bindings",
        severity: "error",
        target: "example-bundle/database",
        requirement: "OwnerReportedFalse",
      }),
      expect.objectContaining({
        checkId: "core/doctor/host-integration-bindings",
        severity: "warning",
        target: "example-bundle/queue",
        requirement: "OwnerReportedUnknown",
      }),
    ]);
  });

  it.each([
    "ReadinessCriterionNotDeclared",
    "ReadinessCriterionNotRegistered",
    "CriterionInvalidResult",
    "CriterionTimedOut",
    "CriterionCheckFailed",
  ])("keeps framework reason %s actionable", (reason) => {
    const [finding] = hostIntegrationInventoryToHealthFindings(
      inventory([contribution({ id: "database", status: "Unknown", reason })]),
    );

    expect(finding).toMatchObject({ requirement: reason });
    expect(finding?.fixHint).toBeTruthy();
  });

  it("does not echo owner-controlled messages or plugin identity", () => {
    const findings = hostIntegrationInventoryToHealthFindings(
      inventory([
        contribution({
          id: "database",
          status: "False",
          reason: "DatabaseUnavailable",
          message: "password=hunter2 at private.internal",
        }),
      ]),
    );
    const rendered = JSON.stringify(findings);

    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("private.internal");
    expect(rendered).not.toContain("secret-owner");
    expect(rendered).not.toContain("secret-plugin");
  });
});

describe("collectHostIntegrationHealthFindings", () => {
  it("uses a bounded Gateway inventory read and returns no finding when absent", async () => {
    const resolveInventory = vi.fn(async () => undefined);

    await expect(
      collectHostIntegrationHealthFindings({ config: {}, resolveInventory }),
    ).resolves.toEqual([]);
    expect(resolveInventory).toHaveBeenCalledWith({
      config: {},
      gatewayReachable: true,
      timeoutMs: 3_000,
    });
  });

  it("passes an explicit timeout to the Gateway inventory read", async () => {
    const resolveInventory = vi.fn(async () => undefined);

    await collectHostIntegrationHealthFindings({
      config: {},
      timeoutMs: 250,
      resolveInventory,
    });

    expect(resolveInventory).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 250 }));
  });
});
