import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
type RustProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  records: Array<Record<string, unknown>>;
};
type RunningRustProcess = {
  child: RustChildProcess;
  processId: number;
  records: Array<Record<string, unknown>>;
  completion: Promise<RustProcessResult>;
};
type FixtureCase = {
  id: string;
  input: {
    command: string;
    params: Record<string, unknown>;
    resultDelayMs?: number;
  };
  expected: Record<string, unknown>;
};
type FencingFixture = {
  fixtureId: string;
  cases: FixtureCase[];
};

const fixture = JSON.parse(
  await fs.readFile(
    path.resolve(".lobster/rust-gateway-unclean-restart-fencing-fixture.json"),
    "utf8",
  ),
) as FencingFixture;
const rejectedCase = fixture.cases.find(
  (entry) => entry.id === "pre-crash-invocation-cannot-settle-after-restart",
);
const acceptedCase = fixture.cases.find(
  (entry) => entry.id === "fresh-post-crash-invocation-executes",
);
if (!rejectedCase || !acceptedCase) {
  throw new Error("Rust Gateway unclean-restart fixture case inventory is incomplete");
}
const acceptedCommand = acceptedCase.input.command;

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

function request<T>(client: GatewayClient, method: string, requestParams?: unknown): Promise<T> {
  return client.request<T>(method, requestParams);
}

async function readPersistedDeviceToken(): Promise<string> {
  return (await fs.readFile(path.join(identityDir, "device-token"), "utf8")).trim();
}

function startRustProcess(mode: string, authToken: string, extraArgs: string[] = []) {
  const child = spawn(
    binary,
    [mode, instance.url, path.join(identityDir, "device-identity.json"), "4", "4", ...extraArgs],
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
  const records: Array<Record<string, unknown>> = [];
  let lineBuffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split(/\r?\n/u);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completion = new Promise<RustProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (lineBuffer.trim()) {
        records.push(JSON.parse(lineBuffer) as Record<string, unknown>);
      }
      resolve({ code, signal, stderr, records });
    });
  });
  return { child, processId, records, completion } satisfies RunningRustProcess;
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
  let pending: { nodeId: string; requestId: string; commands?: string[] } | undefined;
  await vi.waitFor(
    async () => {
      const listed = await request<{
        pending: Array<{ nodeId: string; requestId: string; commands?: string[] }>;
      }>(client, "node.pair.list");
      pending = listed.pending.find(
        (entry) => entry.nodeId === deviceId && entry.commands?.includes(acceptedCommand),
      );
      expect(pending).toBeDefined();
    },
    { timeout: 15_000, interval: 25 },
  );
  if (!pending) {
    throw new Error("timed out waiting for Rust node capability approval");
  }
  return pending;
}

async function waitForNodeAvailable(client: GatewayClient): Promise<void> {
  await vi.waitFor(
    async () => {
      const listed = await request<{
        nodes: Array<{ nodeId: string; paired: boolean; connected: boolean }>;
      }>(client, "node.list");
      expect(listed.nodes.find((entry) => entry.nodeId === deviceId)).toMatchObject({
        paired: true,
        connected: true,
      });
    },
    { timeout: 15_000, interval: 25 },
  );
}

async function pendingCount(client: GatewayClient): Promise<number> {
  const listed = await request<{ pending: Array<{ nodeId: string }> }>(client, "node.pair.list");
  return listed.pending.filter((entry) => entry.nodeId === deviceId).length;
}

async function pairingGeneration(): Promise<string> {
  const state = resolveNodePairingState(await getPairedDevice(deviceId, instance.stateDir));
  if (!state?.generation?.key) {
    throw new Error("approved Rust node has no pairing generation");
  }
  return state.generation.key;
}

describe("Rust Gateway unclean-restart fencing evidence", () => {
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
      name: "rust-gateway-unclean-restart",
      env: {
        OPENCLAW_NODE_COMMANDS: acceptedCase.input.command,
        OPENCLAW_NODE_LISTED_COMMANDS: acceptedCase.input.command,
        OPENCLAW_NODE_REPORTED_BINS: "node",
      },
      startTimeoutMs: 120_000,
    });
    identityDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rust-unclean-restart-"));
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
        displayName: "Rust Gateway unclean-restart fencing",
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

  it("ignores a pre-crash result and accepts only fresh post-crash work", async () => {
    await instance.startGateway();
    const firstGatewayProcessId = instance.child?.pid;
    if (!firstGatewayProcessId) {
      throw new Error("first Gateway process did not receive a process ID");
    }
    const firstClient = await connectControl("rust-unclean-restart-first");
    const firstToken = await readPersistedDeviceToken();
    const oldWorker = startRustProcess("serve-one-delayed", firstToken, [
      String(rejectedCase.input.resultDelayMs),
    ]);
    const pending = await waitForPendingSurface(firstClient);
    await request(firstClient, "node.pair.approve", { requestId: pending.requestId });
    await waitForNodeAvailable(firstClient);
    const firstGeneration = await pairingGeneration();
    expect(await pendingCount(firstClient)).toBe(0);

    const oldInvoke = request(firstClient, "node.invoke", {
      nodeId: deviceId,
      command: rejectedCase.input.command,
      params: rejectedCase.input.params,
      idempotencyKey: randomUUID(),
      timeoutMs: 120_000,
    }).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error: String(error) }),
    );
    let oldDispatch: Record<string, unknown> | undefined;
    await vi.waitFor(
      () => {
        oldDispatch = oldWorker.records.find((entry) => entry.status === "result-delayed");
        expect(oldDispatch).toBeDefined();
      },
      { timeout: 15_000, interval: 25 },
    );
    const oldRequestId = oldDispatch?.requestId;
    expect(oldRequestId).toEqual(expect.any(String));

    const crash = instance.crashGateway();
    const oldWorkerKillSent = oldWorker.child.kill("SIGKILL");
    await crash;
    const oldWorkerResult = await oldWorker.completion;
    expect(oldWorkerKillSent).toBe(true);
    expect(
      oldWorkerResult.code !== 0 || oldWorkerResult.signal !== null,
      oldWorkerResult.stderr,
    ).toBe(true);
    await disconnectGatewayClient(firstClient);
    const oldInvokeOutcome = await Promise.race([
      oldInvoke,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("old invocation did not observe transport loss")),
          15_000,
        );
      }),
    ]);
    expect(oldInvokeOutcome).toMatchObject({
      kind: "rejected",
      error: expect.stringContaining("gateway closed (1006)"),
    });

    await instance.startGateway();
    const secondGatewayProcessId = instance.child?.pid;
    expect(secondGatewayProcessId).toEqual(expect.any(Number));
    expect(secondGatewayProcessId).not.toBe(firstGatewayProcessId);
    const secondClient = await connectControl("rust-unclean-restart-second");
    expect(await pendingCount(secondClient)).toBe(0);
    const secondToken = await readPersistedDeviceToken();

    const staleWorker = startRustProcess("send-stale-result", secondToken, [String(oldRequestId)]);
    const staleWorkerResult = await staleWorker.completion;
    expect(staleWorkerResult.code, staleWorkerResult.stderr).toBe(0);
    expect(staleWorkerResult.records.at(-1)).toMatchObject({
      status: "stale-result-ignored",
      requestId: oldRequestId,
      resultAccepted: true,
      resultIgnored: true,
      sideEffectsExecuted: false,
      authority: "none",
    });
    expect(await pendingCount(secondClient)).toBe(0);

    const freshWorker = startRustProcess("serve-one", secondToken);
    await waitForNodeAvailable(secondClient);
    const freshInvoke = await request<{
      ok: boolean;
      payload?: { bins?: Record<string, string> };
    }>(secondClient, "node.invoke", {
      nodeId: deviceId,
      command: acceptedCase.input.command,
      params: acceptedCase.input.params,
      idempotencyKey: randomUUID(),
      timeoutMs: 10_000,
    });
    const freshWorkerResult = await freshWorker.completion;
    expect(freshWorkerResult.code, freshWorkerResult.stderr).toBe(0);
    const freshResult = freshWorkerResult.records.at(-1);
    expect(freshResult).toMatchObject({
      status: "executed",
      command: acceptedCase.input.command,
      requestsReceived: 1,
      resultAccepted: true,
      resultIgnored: false,
      sideEffectsExecuted: false,
      authority: "none",
    });
    expect(freshResult?.requestId).not.toBe(oldRequestId);
    expect(freshInvoke).toMatchObject({
      ok: true,
      payload: { bins: { node: expect.any(String) } },
    });
    const secondGeneration = await pairingGeneration();
    expect(await pendingCount(secondClient)).toBe(0);

    const evidence = {
      fixtureId: fixture.fixtureId,
      status: "stale-result-fenced-and-fresh-work-accepted",
      command: acceptedCase.input.command,
      selectedProtocol: freshResult?.selectedProtocol,
      gatewayProcessChanged: secondGatewayProcessId !== firstGatewayProcessId,
      rustProcessesChanged:
        new Set([oldWorker.processId, staleWorker.processId, freshWorker.processId]).size === 3,
      pairingGenerationChanged: secondGeneration !== firstGeneration,
      pendingCapabilityApproval: false,
      persistedNodeTokenReused: secondToken === firstToken,
      oldInvocationDispatched: oldDispatch?.status === "result-delayed",
      oldCallerObservedTransportLoss:
        oldInvokeOutcome.kind === "rejected" &&
        oldInvokeOutcome.error.includes("gateway closed (1006)"),
      staleResultRpcAccepted: staleWorkerResult.records.at(-1)?.resultAccepted,
      staleResultIgnored: staleWorkerResult.records.at(-1)?.resultIgnored,
      freshRequestDiffers: freshResult?.requestId !== oldRequestId,
      freshRequestsReceived: freshResult?.requestsReceived,
      freshResultAccepted: freshResult?.resultAccepted,
      sideEffectsExecuted: false,
      runtimeReadinessProven: false,
      rustAuthorityProven: false,
      authority: "none",
    };
    expect(evidence).toEqual({
      fixtureId: fixture.fixtureId,
      ...rejectedCase.expected,
      ...acceptedCase.expected,
      command: acceptedCase.input.command,
    });
    console.log(JSON.stringify(evidence, null, 2));
  }, 120_000);
});
