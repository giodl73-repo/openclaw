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
const FIXTURE_PATH = resolve(".lobster/rust-gateway-stream-input-fixture.json");
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
type InputFixtureCase = {
  id: string;
  input: {
    command: string;
    params: Record<string, unknown>;
    timeoutMs: number;
    frames: Array<Record<string, unknown>>;
  };
  expected: Record<string, unknown>;
};
type InputFixture = {
  fixtureId: string;
  owner: { protocolVersion: number; minimumNodeProtocolVersion: number };
  cases: InputFixtureCase[];
};
type RunningBinary = {
  child: ChildProcessWithoutNullStreams;
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
  if (!child.pid) {
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

function lastJsonLine(output: string): Record<string, unknown> {
  const lines = output.trim().split(/\r?\n/u);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe("Rust Gateway stream input", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as InputFixture;
  const inputCase = fixture.cases.find(
    (entry) => entry.id === "bounded-ordered-input-and-terminal-fencing",
  );
  if (!inputCase || inputCase.input.frames.length !== 2) {
    throw new Error("Rust Gateway stream-input fixture case inventory is incomplete");
  }
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-rust-gateway-stream-input-"));
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
  let worker: RunningBinary | undefined;

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
        displayName: "Rust Gateway stream input",
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
      auth: { mode: "token", token: "rust-stream-input-operator-token" },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    operator = await connectOperator(url, "rust-stream-input-operator-token");
  }, 240_000);

  afterAll(async () => {
    if (worker?.child.exitCode === null) {
      worker.child.kill();
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
    "delivers bounded ordered input and fences input after settlement",
    { timeout: 600_000 },
    async () => {
      if (!operator) {
        throw new Error("operator connection is unavailable");
      }
      worker = startBinary(binary, ["serve-one-input", url, identityPath, "4", "4"], {
        ...process.env,
        OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken,
      });
      await approvePendingNodeSurface(operator, identity.deviceId);
      await waitForConnectedNode(operator, identity.deviceId);

      const context = getFallbackGatewayContext();
      const node = context?.nodeRegistry.get(identity.deviceId);
      if (!context || !node) {
        throw new Error("Gateway node registry did not expose the connected Rust node");
      }
      let requestId = "";
      const invoke = context.nodeRegistry.invoke({
        nodeId: identity.deviceId,
        expectedConnId: node.connId,
        expectedPairingGeneration: node.pairingGeneration,
        command: inputCase.input.command,
        params: inputCase.input.params,
        timeoutMs: inputCase.input.timeoutMs,
        idempotencyKey: crypto.randomUUID(),
        onDispatchReady: (invokeId) => {
          requestId = invokeId;
        },
      });
      const marker = await worker.waitForJsonLine((value) => value.status === "awaiting-input");
      expect(marker).toMatchObject({ requestId });

      expect(() =>
        context.nodeRegistry.sendInvokeInput(requestId, {
          kind: "data",
          data: "x".repeat(17 * 1024),
        }),
      ).toThrow("node invoke input exceeds 16 KiB");
      const oversizedInputRejected = true;
      for (const frame of inputCase.input.frames) {
        context.nodeRegistry.sendInvokeInput(requestId, frame);
      }

      const invokeResult = await invoke;
      expect(invokeResult).toMatchObject({
        ok: true,
        payloadJSON: expect.any(String),
      });
      expect(JSON.parse(invokeResult.payloadJSON ?? "")).toMatchObject({
        bins: { node: expect.any(String) },
        inputs: inputCase.input.frames,
      });
      const workerResult = await worker.completion;
      expect(workerResult.status, workerResult.stderr).toBe(0);
      const result = lastJsonLine(workerResult.stdout);
      expect(result).toMatchObject({
        status: "input-received",
        requestId,
        inputSequences: [0, 1],
        inputPayloads: inputCase.input.frames,
        resultAccepted: true,
        resultIgnored: false,
        sideEffectsExecuted: false,
        authority: "none",
      });

      expect(() => context.nodeRegistry.sendInvokeInput(requestId, { kind: "data" })).toThrow(
        "node invoke is not pending",
      );
      const postSettlementInputRejected = true;
      const evidence = {
        fixtureId: fixture.fixtureId,
        requestDispatched: marker.requestId === requestId,
        oversizedInputRejected,
        deliveredSequences: result.inputSequences,
        deliveredInputs: result.inputPayloads,
        resultAccepted: result.resultAccepted,
        resultIgnored: result.resultIgnored,
        postSettlementInputRejected,
        sideEffectsExecuted: false,
        runtimeReadinessProven: false,
        rustAuthorityProven: false,
        authority: "none",
      };
      expect(evidence).toEqual({ fixtureId: fixture.fixtureId, ...inputCase.expected });
      console.log(JSON.stringify(evidence, null, 2));
    },
  );
});
