import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingState,
} from "../infra/device-pairing.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

type GatewayClient = Awaited<ReturnType<typeof connectGatewayClient>>;
type RustChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type RustNodeResult = {
  code: number | null;
  json: Record<string, unknown>;
  processId: number;
  signal: NodeJS.Signals | null;
  stderr: string;
};

const command = "system.which";
const params = { bins: ["node"] };
const invocationPlatform =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const experimentDir = path.resolve("experiments/rust-gateway-live-admission");
const binary = path.join(
  experimentDir,
  "target",
  "debug",
  process.platform === "win32" ? "rust-gateway-live-admission.exe" : "rust-gateway-live-admission",
);
const cargo =
  process.env.CARGO ??
  (process.platform === "win32" ? path.join(os.homedir(), ".cargo", "bin", "cargo.exe") : "cargo");

let instance: OpenClawTestInstance;
let deviceId: string;
let identityDir: string;

async function readPersistedDeviceToken(): Promise<string> {
  return (await fs.readFile(path.join(identityDir, "device-token"), "utf8")).trim();
}

function startRustNode(authToken: string) {
  const child = spawn(
    binary,
    ["serve-one", instance.url, path.join(identityDir, "device-identity.json"), "4", "4"],
    {
      cwd: experimentDir,
      env: {
        ...process.env,
        OPENCLAW_RUST_CANARY_DEVICE_TOKEN: authToken,
        RUST_BACKTRACE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const processId = child.pid;
  if (!processId) {
    throw new Error("Rust process did not receive a process ID");
  }
  return {
    processId,
    result: collectRustNodeResult(child, processId),
  };
}

async function collectRustNodeResult(
  child: RustChildProcess,
  processId: number,
): Promise<RustNodeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const records = stdout
    .join("")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const json = records.at(-1);
  if (!json) {
    throw new Error(`Rust node emitted no JSON\n${stderr.join("")}`);
  }
  return {
    code,
    json,
    processId,
    signal,
    stderr: stderr.join(""),
  };
}

function request<T>(client: GatewayClient, method: string, requestParams?: unknown): Promise<T> {
  return client.request<T>(method, requestParams);
}

async function connectControl(clientDisplayName: string): Promise<GatewayClient> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 15_000) {
    try {
      return await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        clientDisplayName,
        mode: "backend",
      });
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  throw new Error(`timed out connecting control client: ${String(lastError)}\n${instance.logs()}`);
}

async function waitForPendingSurface(client: GatewayClient) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const listed = await request<{
      pending: Array<{ nodeId: string; requestId: string; commands?: string[] }>;
    }>(client, "node.pair.list");
    const pending = listed.pending.find(
      (entry) => entry.nodeId === deviceId && entry.commands?.includes(command),
    );
    if (pending) {
      return pending;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("timed out waiting for Rust node capability approval");
}

async function waitForNodeAvailable(client: GatewayClient) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const listed = await request<{
      nodes: Array<{ nodeId: string; paired: boolean; connected: boolean }>;
    }>(client, "node.list");
    const node = listed.nodes.find((entry) => entry.nodeId === deviceId);
    if (node?.paired && node.connected) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("timed out waiting for approved Rust node");
}

async function pairingGeneration(): Promise<string> {
  const state = resolveNodePairingState(await getPairedDevice(deviceId, instance.stateDir));
  if (!state?.generation?.key) {
    throw new Error("approved Rust node has no pairing generation");
  }
  return state.generation.key;
}

async function pendingCount(client: GatewayClient): Promise<number> {
  const listed = await request<{ pending: Array<{ nodeId: string }> }>(client, "node.pair.list");
  return listed.pending.filter((entry) => entry.nodeId === deviceId).length;
}

async function invokeOnce(client: GatewayClient, authToken: string) {
  const rust = startRustNode(authToken);
  await waitForNodeAvailable(client);
  const invoked = await request<{
    ok: boolean;
    payload?: { bins?: Record<string, string> };
  }>(client, "node.invoke", {
    nodeId: deviceId,
    command,
    params,
    idempotencyKey: randomUUID(),
    timeoutMs: 10_000,
  });
  const result = await rust.result;
  expect(result.code, result.stderr).toBe(0);
  expect(result.json).toMatchObject({
    status: "executed",
    command,
    resultAccepted: true,
    resultIgnored: false,
    sideEffectsExecuted: false,
    authority: "none",
  });
  expect(invoked).toMatchObject({
    ok: true,
    payload: { bins: { node: expect.any(String) } },
  });
  return result;
}

describe("Rust Gateway cold-restart continuity evidence", () => {
  beforeAll(async () => {
    const built = spawnSync(cargo, ["build", "--quiet", "--locked"], {
      cwd: experimentDir,
      env: { ...process.env, RUST_BACKTRACE: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (built.status !== 0) {
      throw new Error(`cargo build failed\n${built.stdout}\n${built.stderr}`);
    }

    instance = await createOpenClawTestInstance({
      name: "rust-gateway-cold-restart",
      env: {
        OPENCLAW_NODE_COMMANDS: command,
        OPENCLAW_NODE_LISTED_COMMANDS: command,
        OPENCLAW_NODE_REPORTED_BINS: "node",
      },
      startTimeoutMs: 120_000,
    });
    identityDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rust-cold-restart-"));
    const identityPath = path.join(identityDir, "device-identity.json");
    const identityResult = spawnSync(binary, ["identity", identityPath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (identityResult.status !== 0) {
      throw new Error(`Rust identity creation failed\n${identityResult.stderr}`);
    }
    const identity = JSON.parse(identityResult.stdout) as {
      deviceId: string;
      publicKey: string;
    };
    deviceId = identity.deviceId;
    const pairing = await requestDevicePairing(
      {
        deviceId,
        publicKey: identity.publicKey,
        displayName: "Rust Gateway cold-restart continuity",
        platform: invocationPlatform,
        deviceFamily: invocationPlatform,
        clientId: "node-host",
        clientMode: "node",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: false,
      },
      instance.stateDir,
    );
    const approved = await approveDevicePairing(pairing.request.requestId, instance.stateDir);
    if (!approved || approved.status !== "approved") {
      throw new Error("failed to approve the Rust node identity");
    }
    const token = approved.device.tokens?.node?.token;
    if (!token) {
      throw new Error("approved Rust node identity has no node token");
    }
    await fs.writeFile(path.join(identityDir, "device-token"), `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }, 240_000);

  afterAll(async () => {
    try {
      await instance?.cleanup();
    } finally {
      if (identityDir) {
        await fs.rm(identityDir, { recursive: true, force: true });
      }
    }
  });

  it("reuses the approved surface after fresh Gateway and Rust processes", async () => {
    await instance.startGateway();
    const firstGatewayProcess = instance.child;
    if (!firstGatewayProcess?.pid) {
      throw new Error("first Gateway process did not receive a process ID");
    }
    const firstGatewayProcessId = firstGatewayProcess.pid;
    const firstClient = await connectControl("rust-cold-restart-first");

    const firstToken = await readPersistedDeviceToken();
    const firstWorker = startRustNode(firstToken);
    const pending = await waitForPendingSurface(firstClient);
    await request(firstClient, "node.pair.approve", { requestId: pending.requestId });
    await waitForNodeAvailable(firstClient);
    const firstInvoked = await request<{
      ok: boolean;
      payload?: { bins?: Record<string, string> };
    }>(firstClient, "node.invoke", {
      nodeId: deviceId,
      command,
      params,
      idempotencyKey: randomUUID(),
      timeoutMs: 10_000,
    });
    const firstResult = await firstWorker.result;
    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(firstResult.json).toMatchObject({
      status: "executed",
      command,
      resultAccepted: true,
      resultIgnored: false,
      sideEffectsExecuted: false,
      authority: "none",
    });
    expect(firstInvoked).toMatchObject({
      ok: true,
      payload: { bins: { node: expect.any(String) } },
    });
    const firstGeneration = await pairingGeneration();
    expect(await pendingCount(firstClient)).toBe(0);
    await disconnectGatewayClient(firstClient);
    await instance.stopGateway();
    expect(firstGatewayProcess.exitCode !== null || firstGatewayProcess.signalCode !== null).toBe(
      true,
    );

    await instance.startGateway();
    const secondGatewayProcessId = instance.child?.pid;
    expect(secondGatewayProcessId).toEqual(expect.any(Number));
    expect(secondGatewayProcessId).not.toBe(firstGatewayProcessId);
    const secondClient = await connectControl("rust-cold-restart-second");
    expect(await pendingCount(secondClient)).toBe(0);

    const secondToken = await readPersistedDeviceToken();
    const secondResult = await invokeOnce(secondClient, secondToken);
    const secondGeneration = await pairingGeneration();
    expect(secondResult.processId).not.toBe(firstResult.processId);
    expect(secondGeneration).toBe(firstGeneration);
    expect(await pendingCount(secondClient)).toBe(0);

    const evidence = {
      fixtureId: "lobster.rfn.rust-gateway-cold-restart-continuity.v1",
      status: "executed-before-and-after-restart",
      command,
      selectedProtocol: secondResult.json.selectedProtocol,
      gatewayProcessChanged: secondGatewayProcessId !== firstGatewayProcessId,
      rustProcessChanged: secondResult.processId !== firstResult.processId,
      pairingGenerationChanged: secondGeneration !== firstGeneration,
      pendingCapabilityApproval: false,
      persistedNodeTokenReused: secondToken === firstToken,
      firstResultAccepted: firstResult.json.resultAccepted,
      secondResultAccepted: secondResult.json.resultAccepted,
      sideEffectsExecuted: false,
      runtimeReadinessProven: false,
      rustAuthorityProven: false,
      authority: "none",
    };
    expect(evidence).toEqual({
      fixtureId: "lobster.rfn.rust-gateway-cold-restart-continuity.v1",
      status: "executed-before-and-after-restart",
      command,
      selectedProtocol: 4,
      gatewayProcessChanged: true,
      rustProcessChanged: true,
      pairingGenerationChanged: false,
      pendingCapabilityApproval: false,
      persistedNodeTokenReused: true,
      firstResultAccepted: true,
      secondResultAccepted: true,
      sideEffectsExecuted: false,
      runtimeReadinessProven: false,
      rustAuthorityProven: false,
      authority: "none",
    });
    console.log(JSON.stringify(evidence, null, 2));
    await disconnectGatewayClient(secondClient);
  }, 120_000);
});
