import { join } from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import * as mcpLease from "../agents/mcp-lifecycle-lease.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { markClawMcpServerIndependentlyOwned } from "../state/claw-mcp-adoption.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease-error.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { readClawInventory } from "./inventory-read.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  ClawMcpInstallError,
  deleteClawMcpServerRef,
  installClawMcpServers,
  planClawMcpServerRemoval,
  readClawMcpServerRefs,
} from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import { assertClawMutationCurrent, withClawMutationGuard } from "./state-write.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function configuredServers() {
  return {
    docs: {
      command: "uvx",
      args: ["docs-mcp"],
      env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
    },
    linear: {
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      auth: "oauth",
    },
  };
}

async function fixture(agentId = "worker", root?: string) {
  const packageRoot = root ?? tempDirs.make("openclaw-claw-mcp-");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: agentId },
    mcpServers: configuredServers(),
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: `@acme/${agentId}`,
    version: "1.0.0",
    packageRoot,
    manifestPath: join(packageRoot, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(packageRoot, "workspace") },
  });
  return { root: packageRoot, plan, env: { OPENCLAW_STATE_DIR: join(packageRoot, "state") } };
}

function listedMcpServers(mcpServers: Record<string, Record<string, unknown>> = {}) {
  return { ok: true as const, path: "config", config: {}, mcpServers, runtimeConfig: {} };
}

describe("installClawMcpServers", () => {
  it.each(["failed", "complete"] as const)(
    "reports the confirmed %s outcome when the lease wrapper replaces callback settlement",
    async (status) => {
      const current = await fixture();
      const exitError = new OpenClawStateLeaseError("lease exit retired", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
      const originalLease = mcpLease.withClawMcpLifecycleLease;
      vi.spyOn(mcpLease, "withClawMcpLifecycleLease").mockImplementation((name, options, run) => {
        // Run the real lease and worker writes, then simulate the owner's settlement override.
        return originalLease(name, options, run).then(
          () => {
            throw exitError;
          },
          () => {
            throw exitError;
          },
        );
      });
      const setMcpServer = vi.fn(async () =>
        status === "failed"
          ? { ok: false as const, path: "config", error: "configuration rejected" }
          : listedMcpServers(),
      );
      const failure = await installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: async () => listedMcpServers(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const persisted = (await readClawInventory({ env: current.env })).mcpServers;
      expect(failure).toBeInstanceOf(ClawMcpInstallError);
      expect(failure).toMatchObject({
        code: "mcp_install_failed",
        message: status === "failed" ? "configuration rejected" : "lease exit retired",
        mcpServers: persisted,
      });
      expect(persisted).toMatchObject([{ name: "docs", status }]);
      expect(setMcpServer).toHaveBeenCalledOnce();
    },
  );

  it.each(["failed", "configured"] as const)(
    "preserves observed refs when %s outcome bookkeeping loses authority at commit",
    async (outcome) => {
      const current = await fixture();
      const configured: Record<string, Record<string, unknown>> = {};
      let secondEffectSettled = false;
      let retired = false;
      const refusedStages: string[] = [];
      const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          originalAdmission((request, grant) => {
            if (secondEffectSettled && !retired && request.stage === "commit") {
              retired = true;
              refusedStages.push(request.stage);
            }
            admit(request, grant);
          }, attachment),
      );
      const setMcpServer = vi.fn(
        async ({ name, server, assertCurrent }: Parameters<typeof setConfiguredMcpServer>[0]) => {
          assertCurrent?.();
          if (name === "linear") {
            secondEffectSettled = true;
            if (outcome === "failed") {
              return { ok: false as const, path: "config", error: "configuration rejected" };
            }
          }
          const configuredServer = asNullableRecord(server);
          if (!configuredServer) {
            throw new Error("Expected MCP server config");
          }
          configured[name] = configuredServer;
          return listedMcpServers(configured);
        },
      );
      const failure = await withClawMutationGuard(
        () => {
          if (retired) {
            throw new Error("MCP owner retired");
          }
        },
        () =>
          installClawMcpServers(current.plan, {
            env: current.env,
            nowMs: 42,
            setMcpServer,
            listMcpServers: async () => listedMcpServers(configured),
          }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ClawMcpInstallError);
      expect(refusedStages).toEqual(["commit"]);
      const persisted = (await readClawInventory({ env: current.env })).mcpServers;
      expect(failure).toMatchObject({
        code: outcome === "failed" ? "mcp_install_failed" : "mcp_provenance_failed",
        message:
          outcome === "failed"
            ? "configuration rejected"
            : "MCP server was configured, but ownership could not be persisted: MCP owner retired",
        mcpServers: persisted,
      });
      expect(persisted).toMatchObject([
        { name: "docs", status: "complete", updatedAtMs: 42 },
        { name: "linear", status: "pending", updatedAtMs: 42 },
      ]);
      expect(persisted[1]).not.toHaveProperty("error");
      expect(Object.keys(configured)).toEqual(outcome === "failed" ? ["docs"] : ["docs", "linear"]);
      expect(setMcpServer).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["lease", "read", "pending"] as const)(
    "retains earlier confirmed refs when the next %s operation fails",
    async (stage) => {
      const current = await fixture();
      const configured: Record<string, Record<string, unknown>> = {};
      let retired = false;
      const originalLease = mcpLease.withClawMcpLifecycleLease;
      vi.spyOn(mcpLease, "withClawMcpLifecycleLease").mockImplementation(
        async (name, options, run) => {
          if (stage === "lease" && name === "linear") {
            throw new Error("lease unavailable");
          }
          return originalLease(name, options, run);
        },
      );
      const setMcpServer = vi.fn(
        async ({ name, server, assertCurrent }: Parameters<typeof setConfiguredMcpServer>[0]) => {
          assertCurrent?.();
          const configuredServer = asNullableRecord(server);
          if (!configuredServer) {
            throw new Error("Expected MCP server config");
          }
          configured[name] = configuredServer;
          return listedMcpServers(configured);
        },
      );
      const failure = await withClawMutationGuard(
        () => {
          if (retired) {
            throw new Error("pending authority retired");
          }
        },
        () =>
          installClawMcpServers(current.plan, {
            env: current.env,
            setMcpServer,
            listMcpServers: async () => {
              if (configured.docs) {
                if (stage === "read") {
                  throw new Error("read unavailable");
                }
                retired = stage === "pending";
              }
              return listedMcpServers(configured);
            },
          }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      const persisted = (await readClawInventory({ env: current.env })).mcpServers;
      expect(failure).toBeInstanceOf(ClawMcpInstallError);
      expect(failure).toMatchObject({
        code: "mcp_install_failed",
        message: stage === "pending" ? "pending authority retired" : `${stage} unavailable`,
        mcpServers: persisted,
      });
      expect(persisted).toMatchObject([{ name: "docs", status: "complete" }]);
      expect(setMcpServer).toHaveBeenCalledOnce();
    },
  );

  it("uses create-only config writes and stores digest-only ownership", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      nowMs: 42,
    });

    expect(setMcpServer).toHaveBeenNthCalledWith(1, {
      name: "docs",
      server: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      createOnly: true,
      recordIndependentOwner: false,
      assertCurrent: assertClawMutationCurrent,
    });
    expect(setMcpServer).toHaveBeenNthCalledWith(2, {
      name: "linear",
      server: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
      createOnly: true,
      recordIndependentOwner: false,
      assertCurrent: assertClawMutationCurrent,
    });
    expect(refs).toMatchObject([
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "docs",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
      },
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "linear",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        status: "complete",
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("DOCS_TOKEN");
  });

  it("rejects a conflicting existing server without claiming ownership", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        listMcpServers: vi
          .fn()
          .mockResolvedValue(listedMcpServers({ docs: { command: "different" } })),
      }),
    ).rejects.toMatchObject({
      code: "mcp_config_conflict",
      mcpServers: [],
    });
  });

  it("reuses an exact pre-existing server as a referenced resource", async () => {
    const current = await fixture();
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers(configuredServers())),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      {
        name: "docs",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
        status: "complete",
      },
      {
        name: "linear",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
        status: "complete",
      },
    ]);
    expect(planClawMcpServerRemoval(refs[0]!, { env: current.env }).action).toBe("release");
  });

  it("allows another Claw to share an exact Claw-created server", async () => {
    const first = await fixture("worker");
    const firstRefs = await installClawMcpServers(first.plan, {
      env: first.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });
    const second = await fixture("analyst", first.root);
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(second.plan, {
      env: second.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers(configuredServers())),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      {
        agentId: "analyst",
        name: "docs",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
      {
        agentId: "analyst",
        name: "linear",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    ]);
    const firstDocs = firstRefs[0]!;
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env }).action).toBe("release");
    const secondDocs = refs[0]!;
    deleteClawMcpServerRef("worker", "docs", { env: first.env });
    expect(
      planClawMcpServerRemoval(secondDocs, {
        env: first.env,
        referencedCleanup: { mode: "remove-if-unused" },
      }).action,
    ).toBe("remove");
    deleteClawMcpServerRef("analyst", "docs", { env: first.env });
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env }).action).toBe("remove");
  });

  it("serializes concurrent claims for the same MCP server", async () => {
    const first = await fixture("worker");
    const second = await fixture("analyst", first.root);
    const configured: Record<string, Record<string, unknown>> = {};
    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let notifyFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      notifyFirstWrite = resolve;
    });
    const setMcpServer = vi.fn(
      async ({ name, server }: { name: string; server: Record<string, unknown> }) => {
        if (setMcpServer.mock.calls.length === 1) {
          notifyFirstWrite();
          await firstWriteReleased;
        }
        configured[name] = server;
        return listedMcpServers(configured);
      },
    );
    const listMcpServers = vi.fn(async () => listedMcpServers(configured));

    const firstInstall = installClawMcpServers(first.plan, {
      env: first.env,
      setMcpServer,
      listMcpServers,
    });
    await firstWriteStarted;
    const secondInstall = installClawMcpServers(second.plan, {
      env: second.env,
      setMcpServer,
      listMcpServers,
    });
    releaseFirstWrite();

    const [firstRefs, secondRefs] = await Promise.all([firstInstall, secondInstall]);
    expect(setMcpServer).toHaveBeenCalledTimes(2);
    expect(firstRefs).toMatchObject([
      { name: "docs", relationship: "managed", status: "complete" },
      { name: "linear", relationship: "managed", status: "complete" },
    ]);
    expect(secondRefs).toMatchObject([
      {
        name: "docs",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
      },
      {
        name: "linear",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
      },
    ]);
  });

  it("requires explicit conflict consent to remove a pre-existing reference", async () => {
    const current = await fixture();
    const [ref] = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers(configuredServers())),
    });
    const selector = `mcp:${ref!.name}`;

    expect(
      planClawMcpServerRemoval(ref!, {
        env: current.env,
        referencedCleanup: { mode: "remove-selected", selected: [selector] },
      }),
    ).toMatchObject({ action: "release", blocked: true });
    expect(
      planClawMcpServerRemoval(ref!, {
        env: current.env,
        referencedCleanup: {
          mode: "remove-selected",
          selected: [selector],
          allowConflicts: true,
        },
      }),
    ).toMatchObject({ action: "remove", blocked: false });
  });

  it("retains a managed server after an ordinary MCP owner adopts it", async () => {
    const current = await fixture();
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });

    expect(markClawMcpServerIndependentlyOwned("docs", { env: current.env, nowMs: 50 })).toBe(1);
    expect(markClawMcpServerIndependentlyOwned("docs", { env: current.env, nowMs: 60 })).toBe(0);
    const refs = readClawMcpServerRefs("worker", { env: current.env });
    expect(refs).toMatchObject([
      { name: "docs", independentOwner: true, updatedAtMs: 50 },
      { name: "linear", independentOwner: false },
    ]);
    const status = planClawMcpServerRemoval(refs[0]!, { env: current.env });
    expect(status).toMatchObject({ action: "release", blocked: false });
  });

  it("reconciles an ambiguous write from source config on retry", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockRejectedValueOnce(new Error("write result unknown"))
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({
      code: "mcp_install_uncertain",
      mcpServers: [{ name: "docs", status: "pending" }],
    });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue({
        ok: true,
        path: "config",
        config: {},
        mcpServers: {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
        },
      }),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(2);
    expect(refs[0]).toMatchObject({ name: "docs", status: "complete" });
    expect(refs[1]).toMatchObject({ name: "linear", status: "complete" });
  });

  it("retries an ambiguous write that did not reach source config", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockRejectedValueOnce(new Error("write result unknown"))
      .mockResolvedValue(listedMcpServers());
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_install_uncertain" });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(3);
    expect(refs).toEqual([
      expect.objectContaining({ name: "docs", status: "complete" }),
      expect.objectContaining({ name: "linear", status: "complete" }),
    ]);
  });

  it("repairs complete ownership when the configured servers disappeared", async () => {
    const current = await fixture();
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });
    const setMcpServer = vi.fn().mockResolvedValue(listedMcpServers());

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(2);
    expect(refs).toEqual([
      expect.objectContaining({ name: "docs", status: "complete" }),
      expect.objectContaining({ name: "linear", status: "complete" }),
    ]);
  });

  it("does not recreate a removed pre-existing server on retry", async () => {
    const current = await fixture();
    const configured = configuredServers();
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers(configured)),
    });
    const setMcpServer = vi.fn();

    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_reconcile_conflict" });
    expect(setMcpServer).not.toHaveBeenCalled();
  });

  it("does not recreate a removed server after another Claw shares it", async () => {
    const first = await fixture("worker");
    await installClawMcpServers(first.plan, {
      env: first.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });
    const second = await fixture("analyst", first.root);
    const configured = configuredServers();
    await installClawMcpServers(second.plan, {
      env: second.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers(configured)),
    });
    const setMcpServer = vi.fn();

    await expect(
      installClawMcpServers(first.plan, {
        env: first.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_reconcile_conflict" });
    expect(setMcpServer).not.toHaveBeenCalled();
  });
});
