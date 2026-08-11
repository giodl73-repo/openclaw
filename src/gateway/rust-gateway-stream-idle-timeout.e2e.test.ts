import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";
import { approveDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import { startGatewayServer, type GatewayServer } from "./server.js";
import { getFreeGatewayPort } from "./test-helpers.e2e.js";
import { connectReq, rpcReq, trackConnectChallengeNonce } from "./test-helpers.js";

const MANIFEST = resolve("experiments/rust-gateway-live-admission/Cargo.toml");
const FIXTURE_PATH = resolve(".lobster/rust-gateway-stream-idle-timeout-fixture.json");
const CARGO = resolveCargoExecutable();
const INVOCATION_PLATFORM =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const cargoParent = isAbsolute(CARGO) ? resolve(dirname(CARGO), "..") : undefined;
const inferredCargoHome =
  cargoParent && basename(cargoParent).toLowerCase() === ".cargo" ? cargoParent : undefined;
const cargoToolchainEnv = {
  ...(process.env.CARGO_HOME
    ? { CARGO_HOME: process.env.CARGO_HOME }
    : inferredCargoHome
      ? { CARGO_HOME: inferredCargoHome }
      : {}),
  ...(process.env.RUSTUP_HOME
    ? { RUSTUP_HOME: process.env.RUSTUP_HOME }
    : inferredCargoHome
      ? { RUSTUP_HOME: join(dirname(inferredCargoHome), ".rustup") }
      : {}),
};

type PublicIdentity = { deviceId: string; publicKey: string };
type FixtureCase = {
  id: string;
  input: {
    command: string;
    params: Record<string, unknown>;
    timeoutMs: number;
    idleTimeoutMs?: number;
  };
  expected: Record<string, unknown>;
};
type StreamFixture = {
  fixtureId: string;
  owner: { protocolVersion: number; minimumNodeProtocolVersion: number };
  cases: FixtureCase[];
};
type RunningBinary = {
  child: ChildProcessWithoutNullStreams;
  processId: number;
  completion: Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  waitForJsonLine: (
    predicate: (value: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
};

function resolveCargoExecutable(): string {
  if (process.env.CARGO) {
    return process.env.CARGO;
  }
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "cargo";
}

function startBinary(binary: string, args: string[], env: NodeJS.ProcessEnv): RunningBinary {
  const child = spawn(binary, args, { env });
  const processId = child.pid;
  if (!processId) {
    throw new Error("Rust process did not receive a process ID");
  }
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  const observed: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/u);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const value = JSON.parse(line) as Record<string, unknown>;
      observed.push(value);
      for (const waiter of waiters.filter((candidate) => candidate.predicate(value))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(value);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      const error = new Error(
        `Rust process exited before the expected record (status=${String(status)}, signal=${String(signal)}): ${stderr || stdout}`,
      );
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      resolveResult({ status, signal, stdout, stderr });
    });
  });
  return {
    child,
    processId,
    completion,
    waitForJsonLine: (predicate) => {
      const existing = observed.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown>>((resolveWaiter, rejectWaiter) => {
        const waiter: (typeof waiters)[number] = {
          predicate,
          resolve: resolveWaiter,
          reject: rejectWaiter,
          timeout: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rejectWaiter(
              new Error(`Timed out waiting for Rust output record: ${stderr || stdout}`),
            );
          }, 30_000),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function connectOperator(url: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolveOpen, reject) => {
    ws.once("open", resolveOpen);
    ws.once("error", reject);
  });
  const response = await connectReq(ws, {
    token,
    scopes: ["operator.write", "operator.pairing", "operator.admin"],
    timeoutMs: 60_000,
  });
  expect(response.ok).toBe(true);
  return ws;
}

async function approvePendingNodeSurface(ws: WebSocket, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await rpcReq<{
        pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
      }>(ws, "node.pair.list", {}, 10_000);
      const pending = response.payload?.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pending?.commands).toEqual(["system.which"]);
      const approved = await rpcReq(ws, "node.pair.approve", {
        requestId: pending?.requestId,
      });
      expect(approved.ok).toBe(true);
    },
    { timeout: 30_000, interval: 100 },
  );
}

async function waitForConnectedNode(ws: WebSocket, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await rpcReq<{
        nodes?: Array<{ nodeId?: string; connected?: boolean; commands?: string[] }>;
      }>(ws, "node.list", {}, 10_000);
      const node = response.payload?.nodes?.find((entry) => entry.nodeId === nodeId);
      expect(node).toMatchObject({ connected: true, commands: ["system.which"] });
    },
    { timeout: 30_000, interval: 100 },
  );
}

async function pendingCount(ws: WebSocket, nodeId: string): Promise<number> {
  const response = await rpcReq<{ pending?: Array<{ nodeId?: string }> }>(
    ws,
    "node.pair.list",
    {},
    10_000,
  );
  return response.payload?.pending?.filter((entry) => entry.nodeId === nodeId).length ?? 0;
}

function lastJsonLine(output: string): Record<string, unknown> {
  const lines = output.trim().split(/\r?\n/u);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe("Rust Gateway stream idle timeout", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as StreamFixture;
  const streamCase = fixture.cases.find(
    (entry) => entry.id === "ordered-progress-idle-cancel-and-late-frame-fencing",
  );
  const acceptedCase = fixture.cases.find(
    (entry) => entry.id === "fresh-request-after-idle-timeout-executes",
  );
  if (!streamCase || !acceptedCase || streamCase.input.idleTimeoutMs === undefined) {
    throw new Error("Rust Gateway stream idle-timeout fixture case inventory is incomplete");
  }
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-rust-gateway-stream-idle-"));
  const identityPath = join(stateDir, "rust-identity.json");
  const cargoTargetDir = join(stateDir, "cargo-target");
  const binary = join(
    cargoTargetDir,
    "debug",
    process.platform === "win32"
      ? "rust-gateway-live-admission.exe"
      : "rust-gateway-live-admission",
  );
  let server: GatewayServer | undefined;
  let operator: WebSocket | undefined;
  let identity: PublicIdentity;
  let deviceToken: string;
  let url: string;
  const workers: RunningBinary[] = [];

  beforeAll(async () => {
    expect(fixture.owner).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      minimumNodeProtocolVersion: MIN_NODE_PROTOCOL_VERSION,
    });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    execFileSync(CARGO, ["build", "--locked", "--manifest-path", MANIFEST], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...cargoToolchainEnv, CARGO_TARGET_DIR: cargoTargetDir },
    });
    identity = JSON.parse(
      execFileSync(binary, ["identity", identityPath], { encoding: "utf8" }),
    ) as PublicIdentity;
    const pairing = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        displayName: "Rust Gateway stream idle timeout",
        platform: INVOCATION_PLATFORM,
        deviceFamily: INVOCATION_PLATFORM,
        clientId: "node-host",
        clientMode: "node",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: false,
      },
      stateDir,
    );
    const approval = await approveDevicePairing(pairing.request.requestId, stateDir);
    if (!approval || approval.status !== "approved") {
      throw new Error("failed to approve the Rust node identity");
    }
    const token = approval.device.tokens?.node?.token;
    if (!token) {
      throw new Error("approved Rust node identity has no node token");
    }
    deviceToken = token;
    const port = await getFreeGatewayPort();
    url = `ws://127.0.0.1:${port}`;
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "rust-stream-idle-operator-token" },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    operator = await connectOperator(url, "rust-stream-idle-operator-token");
  }, 240_000);

  afterAll(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null) {
        worker.child.kill();
      }
    }
    operator?.close();
    await server?.close();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalMinimalGateway === undefined) {
      delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    } else {
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = originalMinimalGateway;
    }
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it(
    "orders progress, cancels on idle, fences late frames, and accepts fresh work",
    { timeout: 600_000 },
    async () => {
      if (!operator) {
        throw new Error("operator connection is unavailable");
      }
      const env = { ...process.env, OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken };
      const streamWorker = startBinary(
        binary,
        ["serve-one-stream-idle", url, identityPath, "4", "4"],
        env,
      );
      workers.push(streamWorker);
      await approvePendingNodeSurface(operator, identity.deviceId);
      await waitForConnectedNode(operator, identity.deviceId);

      const context = getFallbackGatewayContext();
      const streamNode = context?.nodeRegistry.get(identity.deviceId);
      if (!context || !streamNode) {
        throw new Error("Gateway node registry did not expose the connected Rust node");
      }
      const deliveredProgress: string[] = [];
      let streamRequestId = "";
      const streamInvoke = context.nodeRegistry.invoke({
        nodeId: identity.deviceId,
        expectedConnId: streamNode.connId,
        expectedPairingGeneration: streamNode.pairingGeneration,
        command: streamCase.input.command,
        params: streamCase.input.params,
        timeoutMs: streamCase.input.timeoutMs,
        idleTimeoutMs: streamCase.input.idleTimeoutMs,
        idempotencyKey: crypto.randomUUID(),
        onDispatchReady: (invokeId) => {
          streamRequestId = invokeId;
        },
        onProgress: (chunk) => deliveredProgress.push(chunk),
      });
      const streamMarker = await streamWorker.waitForJsonLine(
        (value) => value.status === "progress-sent-awaiting-idle-cancel",
      );
      expect(streamMarker).toMatchObject({
        requestId: streamRequestId,
        sentSequences: [1, 0],
      });
      expect(deliveredProgress).toEqual(["first", "second"]);
      await expect(streamInvoke).resolves.toEqual({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });

      const streamWorkerResult = await streamWorker.completion;
      expect(streamWorkerResult.status, streamWorkerResult.stderr).toBe(0);
      const streamResult = lastJsonLine(streamWorkerResult.stdout);
      expect(streamResult).toMatchObject({
        status: "idle-cancel-observed",
        requestId: streamRequestId,
        cancellationObserved: true,
        cancellationRequestId: streamRequestId,
        progressDispositions: [
          { accepted: true, ignored: false },
          { accepted: true, ignored: false },
        ],
        lateProgressAccepted: true,
        lateProgressIgnored: true,
        resultAccepted: true,
        resultIgnored: true,
        sideEffectsExecuted: false,
        authority: "none",
      });
      expect(await pendingCount(operator, identity.deviceId)).toBe(0);

      const freshWorker = startBinary(binary, ["serve-one", url, identityPath, "4", "4"], env);
      workers.push(freshWorker);
      await waitForConnectedNode(operator, identity.deviceId);
      expect(await pendingCount(operator, identity.deviceId)).toBe(0);
      const freshNode = getFallbackGatewayContext()?.nodeRegistry.get(identity.deviceId);
      if (!freshNode) {
        throw new Error("Gateway node registry did not expose the fresh Rust node");
      }
      const freshResponse = await rpcReq(
        operator,
        "node.invoke",
        {
          nodeId: identity.deviceId,
          command: acceptedCase.input.command,
          params: acceptedCase.input.params,
          timeoutMs: acceptedCase.input.timeoutMs,
          idempotencyKey: crypto.randomUUID(),
        },
        30_000,
      );
      expect(freshResponse).toMatchObject({
        ok: true,
        payload: { ok: true, payload: { bins: { node: expect.any(String) } } },
      });
      const freshWorkerResult = await freshWorker.completion;
      expect(freshWorkerResult.status, freshWorkerResult.stderr).toBe(0);
      const freshResult = lastJsonLine(freshWorkerResult.stdout);
      expect(freshResult).toMatchObject({
        status: "executed",
        requestsReceived: 1,
        resultAccepted: true,
        resultIgnored: false,
        sideEffectsExecuted: false,
        authority: "none",
      });

      const evidence = {
        fixtureId: fixture.fixtureId,
        status: "ordered-idle-cancel-fenced-and-fresh-work-accepted",
        command: acceptedCase.input.command,
        selectedProtocol: freshResult.selectedProtocol,
        rustProcessChanged: freshWorker.processId !== streamWorker.processId,
        connectionChanged: freshNode.connId !== streamNode.connId,
        pairingGenerationChanged: freshNode.pairingGeneration !== streamNode.pairingGeneration,
        pendingCapabilityApproval: false,
        streamRequestDispatched: streamMarker.requestId === streamRequestId,
        sentSequences: streamMarker.sentSequences,
        deliveredProgress,
        invokeCode: "IDLE_TIMEOUT",
        cancellationObserved: streamResult.cancellationObserved,
        cancellationRequestCorrelated: streamResult.cancellationRequestId === streamRequestId,
        lateProgressRpcAccepted: streamResult.lateProgressAccepted,
        lateProgressIgnored: streamResult.lateProgressIgnored,
        lateResultRpcAccepted: streamResult.resultAccepted,
        lateResultIgnored: streamResult.resultIgnored,
        freshRequestDiffers: freshResult.requestId !== streamRequestId,
        freshRequestsReceived: freshResult.requestsReceived,
        freshResultAccepted: freshResult.resultAccepted,
        sideEffectsExecuted: false,
        runtimeReadinessProven: false,
        rustAuthorityProven: false,
        authority: "none",
      };
      expect(evidence).toEqual({
        fixtureId: fixture.fixtureId,
        ...streamCase.expected,
        ...acceptedCase.expected,
        command: acceptedCase.input.command,
      });
      console.log(JSON.stringify(evidence, null, 2));
    },
  );
});
