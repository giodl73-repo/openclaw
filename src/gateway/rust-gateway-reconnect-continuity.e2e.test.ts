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
import { NodeRegistry } from "./node-registry.js";
import { startGatewayServer, type GatewayServer } from "./server.js";
import { getFreeGatewayPort } from "./test-helpers.e2e.js";
import { connectReq, rpcReq, trackConnectChallengeNonce } from "./test-helpers.js";

const MANIFEST = resolve("experiments/rust-gateway-live-admission/Cargo.toml");
const FIXTURE_PATH = resolve(".lobster/rust-gateway-reconnect-continuity-fixture.json");
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
    resultDelayMs?: number;
  };
  expected: Record<string, unknown>;
};
type ContinuityFixture = {
  owner: { protocolVersion: number; minimumNodeProtocolVersion: number };
  cases: FixtureCase[];
};
type RunningBinary = {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ status: number | null; stdout: string; stderr: string }>;
  waitForJsonLine: (predicate: (value: Record<string, unknown>) => boolean) => Promise<void>;
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
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  const observed: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: () => void;
  }> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const value = JSON.parse(line) as Record<string, unknown>;
      observed.push(value);
      for (const waiter of waiters.filter((candidate) => candidate.predicate(value))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolveResult({ status, stdout, stderr }));
    },
  );
  return {
    child,
    completion,
    waitForJsonLine: (predicate) => {
      if (observed.some(predicate)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveWaiter) => {
        waiters.push({ predicate, resolve: resolveWaiter });
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
    { timeout: 600_000, interval: 100 },
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
    { timeout: 600_000, interval: 100 },
  );
}

function lastJsonLine(output: string): Record<string, unknown> {
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe("Rust Gateway reconnect continuity", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ContinuityFixture;
  const acceptedCase = fixture.cases.find(
    (entry) => entry.id === "replacement-connection-executes",
  );
  const rejectedCase = fixture.cases.find(
    (entry) => entry.id === "superseded-connection-late-result-refused",
  );
  if (!acceptedCase || !rejectedCase) {
    throw new Error("Rust Gateway reconnect fixture case inventory is incomplete");
  }
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-rust-gateway-reconnect-"));
  const identityPath = join(stateDir, "rust-identity.json");
  const cargoTargetDir = join(stateDir, "cargo-target");
  const binary = join(
    cargoTargetDir,
    "debug",
    process.platform === "win32"
      ? "rust-gateway-live-admission.exe"
      : "rust-gateway-live-admission",
  );
  const invokeSpy = vi.spyOn(NodeRegistry.prototype, "invoke");
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
        displayName: "Rust Gateway reconnect continuity",
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
      auth: { mode: "token", token: "rust-reconnect-operator-token" },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    operator = await connectOperator(url, "rust-reconnect-operator-token");
  }, 240_000);

  afterAll(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null) {
        worker.child.kill();
      }
    }
    operator?.close();
    invokeSpy.mockRestore();
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
    "fences a superseded Rust connection and accepts only the replacement result",
    { timeout: 600_000 },
    async () => {
      if (!operator) {
        throw new Error("operator connection is unavailable");
      }
      const env = { ...process.env, OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken };
      const oldWorker = startBinary(
        binary,
        [
          "serve-one-delayed",
          url,
          identityPath,
          String(PROTOCOL_VERSION),
          String(PROTOCOL_VERSION),
          String(rejectedCase.input.resultDelayMs),
        ],
        env,
      );
      workers.push(oldWorker);
      await approvePendingNodeSurface(operator, identity.deviceId);
      await waitForConnectedNode(operator, identity.deviceId);

      const oldInvoke = rpcReq(operator, "node.invoke", {
        nodeId: identity.deviceId,
        command: rejectedCase.input.command,
        params: rejectedCase.input.params,
        idempotencyKey: crypto.randomUUID(),
      });
      await oldWorker.waitForJsonLine((value) => value.status === "result-delayed");
      const oldDispatch = invokeSpy.mock.calls[0]?.[0];
      expect(oldDispatch).toMatchObject({
        nodeId: identity.deviceId,
        expectedConnId: expect.any(String),
        expectedPairingGeneration: expect.any(String),
      });

      const replacementWorker = startBinary(
        binary,
        ["serve-one", url, identityPath, String(PROTOCOL_VERSION), String(PROTOCOL_VERSION)],
        env,
      );
      workers.push(replacementWorker);
      const disconnected = await oldInvoke;
      expect(disconnected).toMatchObject({
        ok: false,
        error: {
          code: rejectedCase.expected.gatewayCode,
          details: {
            nodeError: { code: rejectedCase.expected.invokeCode },
            nodeCommandDispatched: true,
          },
        },
      });
      await waitForConnectedNode(operator, identity.deviceId);

      const replacementInvoke = await rpcReq<{
        ok?: boolean;
        payload?: { bins?: Record<string, string> };
      }>(
        operator,
        "node.invoke",
        {
          nodeId: identity.deviceId,
          command: acceptedCase.input.command,
          params: acceptedCase.input.params,
          idempotencyKey: crypto.randomUUID(),
        },
        60_000,
      );
      expect(replacementInvoke).toMatchObject({
        ok: true,
        payload: { ok: true, payload: { bins: { node: expect.any(String) } } },
      });
      expect(invokeSpy).toHaveBeenCalledTimes(2);
      const replacementDispatch = invokeSpy.mock.calls[1]?.[0];
      expect(replacementDispatch?.expectedConnId).not.toBe(oldDispatch?.expectedConnId);
      expect(replacementDispatch?.expectedPairingGeneration).toBe(
        oldDispatch?.expectedPairingGeneration,
      );

      const [oldResult, replacementResult] = await Promise.all([
        oldWorker.completion,
        replacementWorker.completion,
      ]);
      expect(oldResult).toMatchObject({ status: 0, stderr: "" });
      expect(replacementResult).toMatchObject({ status: 0, stderr: "" });
      expect(lastJsonLine(oldResult.stdout)).toMatchObject({
        status: rejectedCase.expected.processStatus,
        authority: "none",
        resultAccepted: false,
        resultIgnored: false,
        resultGatewayCode: rejectedCase.expected.resultGatewayCode,
        resultReasonCode: rejectedCase.expected.resultReasonCode,
        sideEffectsExecuted: false,
      });
      expect(lastJsonLine(replacementResult.stdout)).toMatchObject({
        ...acceptedCase.expected,
        deviceId: identity.deviceId,
        result: { bins: { node: expect.any(String) } },
      });
    },
  );
});
