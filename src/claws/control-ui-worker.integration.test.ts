import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import JSON5 from "json5";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { readConfigHealthStateFromStoreAsync } from "../config/io.health-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { planClawAddFromCatalog } from "./control-ui-plan.js";
import { planClawUpdateFromCatalog } from "./control-ui-update-plan.js";
import type { ClawControlUiHost } from "./control-ui-worker-contract.js";
import { runClawControlUiOperation } from "./control-ui-worker.js";
import { readClawInventory } from "./inventory-read.js";

const packageName = "worker-proof-claw";
const agentId = "worker-proof";
const packagePath = `/api/v1/packages/${packageName}`;

async function packRelease(root: string, version: string, soul: string) {
  const releaseRoot = path.join(root, version);
  const packageRoot = path.join(releaseRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      openclaw: { claw: "openclaw.claw.json" },
    }),
  );
  await writeFile(
    path.join(packageRoot, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: agentId, name: "Worker Proof" },
      workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
    }),
  );
  await writeFile(path.join(packageRoot, "SOUL.md"), soul);
  const archivePath = path.join(releaseRoot, "package.tgz");
  await tar.c({ cwd: releaseRoot, file: archivePath, gzip: true, portable: true }, ["package"]);
  const bytes = await readFile(archivePath);
  return {
    version,
    soul,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    npmIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

async function startRegistry(releases: Awaited<ReturnType<typeof packRelease>>[]) {
  const routes = new Map<string, { body: string | Buffer; headers?: Record<string, string> }>();
  const identity = { name: packageName, displayName: "Worker Proof", family: "claw" };
  routes.set(packagePath, {
    body: JSON.stringify({
      package: {
        ...identity,
        latestVersion: "1.1.0",
        channel: "community",
        isOfficial: false,
        createdAt: 1,
        updatedAt: 2,
      },
      owner: { handle: "fixture", displayName: "Fixture Publisher" },
    }),
  });
  for (const release of releases) {
    const prefix = `${packagePath}/versions/${release.version}`;
    routes.set(prefix, {
      body: JSON.stringify({
        package: identity,
        version: { version: release.version, createdAt: 1, changelog: "Synthetic release." },
      }),
    });
    routes.set(`${prefix}/artifact`, {
      body: JSON.stringify({
        package: identity,
        version: release.version,
        artifact: {
          source: "clawhub",
          artifactKind: "npm-pack",
          packageName,
          version: release.version,
          artifactSha256: release.sha256,
          npmIntegrity: release.npmIntegrity,
        },
      }),
    });
    routes.set(`${prefix}/security`, {
      body: JSON.stringify({
        package: identity,
        release: { version: release.version },
        overview: "Synthetic local fixture is clean.",
        securityAuditUrl: "http://127.0.0.1/fixture-security",
        trust: {
          scanStatus: "clean",
          moderationState: "approved",
          blockedFromDownload: false,
          reasons: [],
          pending: false,
          stale: false,
        },
      }),
    });
    routes.set(`${prefix}/artifact/download`, {
      body: release.bytes,
      headers: {
        "Content-Type": "application/gzip",
        "X-ClawHub-Artifact-Sha256": release.sha256,
        "X-ClawHub-Npm-Integrity": release.npmIntegrity,
        "X-ClawHub-Npm-Tarball-Name": `${packageName}-${release.version}.tgz`,
      },
    });
  }
  const requests: string[] = [];
  const unexpected: string[] = [];
  let receivedCredentials = false;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        requests.push(requestPath);
        receivedCredentials ||=
          req.headers.authorization !== undefined || req.headers.cookie !== undefined;
        const route = req.method === "GET" ? routes.get(requestPath) : undefined;
        if (!route || receivedCredentials) {
          unexpected.push(`${req.method} ${requestPath}`);
          res.writeHead(400).end("Unexpected fixture request.");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", ...route.headers });
        res.end(route.body);
      }),
  });
  return {
    url: `http://127.0.0.1:${reservation.claim.port}`,
    requests,
    unexpected,
    receivedCredentials: () => receivedCredentials,
    async close() {
      try {
        reservation.listener.closeIdleConnections();
        await reservation.releaseListener();
      } finally {
        await reservation.claim.release();
      }
    },
  };
}

// Real worker/canonical lifecycle proof, not browser E2E or Gateway reload proof.
// Only config observation and agent.ready are shimmed; no lifecycle results are fabricated.
describe("Claw Control UI worker with a local ClawHub registry", () => {
  it(
    "adds 1.0.0 and updates to 1.1.0 through reviewed plans and durable owners",
    { timeout: 60_000 },
    async () => {
      const blankCredentials = Object.fromEntries(
        Object.keys(process.env)
          .filter((key) => /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_?KEY)/i.test(key))
          .map((key) => [key, ""]),
      );
      await withOpenClawTestState(
        {
          label: "claws-control-ui-worker",
          layout: "home",
          env: {
            ...blankCredentials,
            OPENCLAW_EXPERIMENTAL_CLAWS: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            CLAWHUB_TOKEN: "",
            CLAWHUB_AUTH_TOKEN: "",
          },
        },
        async (state) => {
          Object.assign(state.envVars, {
            XDG_CONFIG_HOME: state.path("xdg"),
            APPDATA: state.path("appdata"),
            LOCALAPPDATA: state.path("localappdata"),
            CLAWHUB_CONFIG_PATH: state.path("clawhub-config.json"),
            CLAWDHUB_CONFIG_PATH: state.path("clawhub-config.json"),
          });
          await writeFile(state.path("clawhub-config.json"), "{}\n");
          state.applyEnv();
          const initialConfig: OpenClawConfig = {
            agents: {
              defaults: {
                heartbeat: { agentId: "main" },
                systemAgent: { agentId: "main" },
              },
              entries: { main: { workspace: state.workspaceDir } },
            },
            plugins: { enabled: false },
          };
          await state.writeConfig(initialConfig);
          const readConfig = () =>
            JSON5.parse(readFileSync(state.configPath, "utf8")) as OpenClawConfig;
          const first = await packRelease(
            state.path("releases"),
            "1.0.0",
            "# Worker Proof\nOriginal instructions.\n",
          );
          const second = await packRelease(
            state.path("releases"),
            "1.1.0",
            "# Worker Proof\nUpdated instructions.\n",
          );
          const registry = await startRegistry([first, second]);
          let authorityCurrent = true;
          try {
            state.envVars.OPENCLAW_CLAWHUB_URL = registry.url;
            state.applyEnv();
            const assertCurrent = vi.fn(() => {
              if (!authorityCurrent) {
                throw new Error("Fixture lifecycle authority closed.");
              }
            });
            const readyAgents: string[] = [];
            const host: ClawControlUiHost = async ({ method, params }) => {
              assertCurrent();
              if (method === "config") {
                return readConfig();
              }
              if (method === "agent.ready") {
                if (
                  typeof params.agentId !== "string" ||
                  !readConfig().agents?.entries?.[params.agentId]
                ) {
                  throw new Error("Worker did not publish the fixture agent configuration.");
                }
                readyAgents.push(params.agentId);
                return undefined;
              }
              throw new Error(`Unexpected host request in the package-only fixture: ${method}`);
            };

            const configBefore = await readFile(state.configPath, "utf8");
            const addSource = { packageName, version: first.version };
            const addPlan = await planClawAddFromCatalog({
              source: addSource,
              agentId,
              getRuntimeConfig: readConfig,
            });
            expect(addPlan.blockers).toEqual([]);
            expect(addPlan.target).toMatchObject({ agentId, targetVersion: first.version });
            expect(await readFile(state.configPath, "utf8")).toBe(configBefore);
            expect((await readClawInventory()).installs).toEqual([]);

            const added = await runClawControlUiOperation(
              {
                operation: "add",
                params: {
                  source: addSource,
                  agentId,
                  planIntegrity: addPlan.planIntegrity,
                  acknowledgeClawHubRisk: true,
                },
              },
              { assertCurrent, request: host },
            );
            expect(added).toMatchObject({ operation: "add", status: "complete", agentId });
            const addedInventory = await readClawInventory();
            expect(addedInventory.installs).toHaveLength(1);
            const installed = expectDefined(addedInventory.installs[0], "installed Claw");
            expect(installed).toMatchObject({
              agentId,
              status: "complete",
              claw: {
                name: packageName,
                version: first.version,
                integrity: `sha256:${first.sha256}`,
              },
            });
            expect(readConfig().agents?.entries?.[agentId]?.workspace).toBe(installed.workspace);
            expect(path.relative(state.home, installed.workspace).startsWith("..")).toBe(false);
            const soulPath = path.join(installed.workspace, "SOUL.md");
            expect(await readFile(soulPath, "utf8")).toBe(first.soul);
            expect(await readFile(path.join(installed.claw.packageRoot, "SOUL.md"), "utf8")).toBe(
              first.soul,
            );
            expect(addedInventory.workspaceFiles).toContainEqual(
              expect.objectContaining({
                agentId,
                path: "SOUL.md",
                status: "complete",
                contentDigest: `sha256:${createHash("sha256").update(first.soul).digest("hex")}`,
              }),
            );

            const updateSource = { packageName, version: second.version };
            const updatePlan = await planClawUpdateFromCatalog({
              target: agentId,
              source: updateSource,
              getRuntimeConfig: readConfig,
            });
            expect(updatePlan.blockers).toEqual([]);
            expect(updatePlan.target).toMatchObject({
              agentId,
              currentVersion: first.version,
              targetVersion: second.version,
            });
            expect(await readFile(soulPath, "utf8")).toBe(first.soul);
            const updated = await runClawControlUiOperation(
              {
                operation: "update",
                params: {
                  target: agentId,
                  source: updateSource,
                  planIntegrity: updatePlan.planIntegrity,
                  acknowledgeClawHubRisk: true,
                },
              },
              { assertCurrent, request: host },
            );
            expect(updated).toMatchObject({ operation: "update", status: "complete", agentId });
            const updatedInventory = await readClawInventory();
            expect(updatedInventory.installs).toHaveLength(1);
            const current = expectDefined(updatedInventory.installs[0], "updated Claw");
            expect(current).toMatchObject({
              agentId,
              workspace: installed.workspace,
              status: "complete",
              claw: {
                name: packageName,
                version: second.version,
                integrity: `sha256:${second.sha256}`,
              },
            });
            expect(await readFile(soulPath, "utf8")).toBe(second.soul);
            expect(await readFile(path.join(current.claw.packageRoot, "SOUL.md"), "utf8")).toBe(
              second.soul,
            );
            expect(updatedInventory.workspaceFiles).toContainEqual(
              expect.objectContaining({
                agentId,
                path: "SOUL.md",
                status: "complete",
                contentDigest: `sha256:${createHash("sha256").update(second.soul).digest("hex")}`,
              }),
            );
            expect(readConfig().agents?.entries?.[agentId]?.workspace).toBe(installed.workspace);
            expect(readConfig().agents?.entries?.main).toEqual(initialConfig.agents?.entries?.main);
            expect(readConfig().agents?.defaults).toEqual(initialConfig.agents?.defaults);
            const health = await readConfigHealthStateFromStoreAsync({
              env: process.env,
              homedir: () => state.home,
              logger: console,
            });
            expect(health.entries?.[state.configPath]?.lastKnownGood?.hash).toBe(
              createHash("sha256")
                .update(await readFile(state.configPath))
                .digest("hex"),
            );
            expect(readyAgents).toEqual([agentId, agentId]);
            expect(assertCurrent).toHaveBeenCalled();
            expect(registry.unexpected).toEqual([]);
            expect(registry.receivedCredentials()).toBe(false);
            for (const release of [first, second]) {
              expect(
                registry.requests.filter(
                  (requestPath) =>
                    requestPath === `${packagePath}/versions/${release.version}/artifact/download`,
                ).length,
              ).toBeGreaterThanOrEqual(2);
            }
          } finally {
            authorityCurrent = false;
            try {
              await closeStateDatabaseForTest();
            } finally {
              await registry.close();
            }
          }
        },
      );
    },
  );
});
