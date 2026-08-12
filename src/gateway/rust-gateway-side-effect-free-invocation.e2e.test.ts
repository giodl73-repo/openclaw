import { execFileSync, spawn } from "node:child_process";
import crypto, { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const FIXTURE_PATH = resolve(".lobster/rust-gateway-side-effect-free-invocation-fixture.json");
const CARGO = resolveCargoExecutable();
const PROVIDED_ARTIFACT = process.env.OPENCLAW_RUST_ARTIFACT_BINARY;
const EXPECTED_ARTIFACT_SHA256 = process.env.OPENCLAW_RUST_ARTIFACT_SHA256;
const ARTIFACT_RECEIPT_PATH = process.env.OPENCLAW_RUST_ARTIFACT_RECEIPT_PATH;
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

type PublicIdentity = {
  deviceId: string;
  publicKey: string;
};

type InvocationFixture = {
  owner: {
    protocolVersion: number;
    minimumNodeProtocolVersion: number;
  };
  cases: Array<{
    id: string;
    input: { command: string; params: Record<string, unknown> };
    expected: Record<string, unknown>;
  }>;
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

function runBinary(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });
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
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const response = await rpcReq<{
      pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
    }>(ws, "node.pair.list", {}, Math.max(1_000, deadline - Date.now()));
    const pending = response.payload?.pending?.find((entry) => entry.nodeId === nodeId);
    if (pending?.requestId) {
      expect(pending.commands).toEqual(["system.which"]);
      const approved = await rpcReq(ws, "node.pair.approve", {
        requestId: pending.requestId,
      });
      expect(approved.ok).toBe(true);
      return;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  throw new Error("timed out waiting for the Rust node capability declaration");
}

async function waitForConnectedNode(ws: WebSocket, nodeId: string): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const response = await rpcReq<{
      nodes?: Array<{ nodeId?: string; connected?: boolean; commands?: string[] }>;
    }>(ws, "node.list", {}, Math.max(1_000, deadline - Date.now()));
    const node = response.payload?.nodes?.find((entry) => entry.nodeId === nodeId);
    if (node?.connected) {
      expect(node.commands).toEqual(["system.which"]);
      return;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  throw new Error("timed out waiting for the Rust invocation node");
}

describe("Rust Gateway side-effect-free invocation", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as InvocationFixture;
  const acceptedCase = fixture.cases.find((entry) => entry.id === "declared-system-which-executed");
  const rejectedCase = fixture.cases.find(
    (entry) => entry.id === "undeclared-system-notify-refused",
  );
  if (!acceptedCase || !rejectedCase) {
    throw new Error("Rust Gateway invocation fixture case inventory is incomplete");
  }
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-rust-gateway-invocation-"));
  const identityPath = join(stateDir, "rust-identity.json");
  const cargoTargetDir = join(stateDir, "cargo-target");
  const binary = PROVIDED_ARTIFACT
    ? resolve(PROVIDED_ARTIFACT)
    : join(
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

  beforeAll(async () => {
    expect(fixture.owner).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      minimumNodeProtocolVersion: MIN_NODE_PROTOCOL_VERSION,
    });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    if (PROVIDED_ARTIFACT) {
      expect(existsSync(binary)).toBe(true);
      expect(EXPECTED_ARTIFACT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
      expect(createHash("sha256").update(readFileSync(binary)).digest("hex")).toBe(
        EXPECTED_ARTIFACT_SHA256,
      );
      expect(JSON.parse(execFileSync(binary, ["artifact-profile"], { encoding: "utf8" }))).toEqual({
        schemaVersion: 1,
        profileId: "rust-gateway-side-effect-free-v1",
        clientVersion: "rust-gateway-live-admission/0.1.0",
        commands: ["system.which"],
        sideEffectsAllowed: false,
        runtimeReadinessProven: false,
        rustAuthorityProven: false,
        authority: "none",
      });
    } else {
      execFileSync(CARGO, ["build", "--locked", "--manifest-path", MANIFEST], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          ...cargoToolchainEnv,
          CARGO_TARGET_DIR: cargoTargetDir,
        },
      });
    }
    identity = JSON.parse(
      execFileSync(binary, ["identity", identityPath], { encoding: "utf8" }),
    ) as PublicIdentity;
    const devicePairing = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        displayName: "Rust Gateway side-effect-free invocation",
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
    const deviceApproval = await approveDevicePairing(devicePairing.request.requestId, stateDir);
    if (!deviceApproval || deviceApproval.status !== "approved") {
      throw new Error("failed to approve the Rust node identity");
    }
    const token = deviceApproval.device.tokens?.node?.token;
    if (!token) {
      throw new Error("approved Rust node identity has no node token");
    }
    deviceToken = token;
    const port = await getFreeGatewayPort();
    url = `ws://127.0.0.1:${port}`;
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "rust-invocation-operator-token" },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    operator = await connectOperator(url, "rust-invocation-operator-token");
  }, 240_000);

  afterAll(async () => {
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
    "executes only declared system.which through fenced Gateway dispatch",
    { timeout: 600_000 },
    async () => {
      if (!operator) {
        throw new Error("operator connection is unavailable");
      }
      const rustResult = runBinary(
        binary,
        ["serve-one", url, identityPath, String(PROTOCOL_VERSION), String(PROTOCOL_VERSION)],
        {
          ...process.env,
          OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken,
        },
      );
      await approvePendingNodeSurface(operator, identity.deviceId);
      await waitForConnectedNode(operator, identity.deviceId);

      const rejected = await rpcReq(operator, "node.invoke", {
        nodeId: identity.deviceId,
        command: rejectedCase.input.command,
        params: rejectedCase.input.params,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatchObject({
        code: rejectedCase.expected.code,
        details: { reason: rejectedCase.expected.reason },
      });
      expect(invokeSpy).not.toHaveBeenCalled();

      const accepted = await rpcReq<{
        ok?: boolean;
        nodeId?: string;
        command?: string;
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
      expect(accepted.ok).toBe(true);
      expect(accepted.payload).toMatchObject({
        ok: true,
        nodeId: identity.deviceId,
        command: "system.which",
        payload: { bins: { node: expect.any(String) } },
      });
      expect(invokeSpy).toHaveBeenCalledTimes(1);
      const dispatch = invokeSpy.mock.calls[0]?.[0];
      expect(dispatch).toMatchObject({
        nodeId: identity.deviceId,
        command: "system.which",
        expectedConnId: expect.any(String),
        expectedPairingGeneration: expect.any(String),
      });
      if (PROVIDED_ARTIFACT) {
        expect(ARTIFACT_RECEIPT_PATH).toBeTruthy();
        writeFileSync(
          ARTIFACT_RECEIPT_PATH!,
          `${JSON.stringify({
            artifactSha256: EXPECTED_ARTIFACT_SHA256,
            profileId: "rust-gateway-side-effect-free-v1",
            selectedProtocol: PROTOCOL_VERSION,
            commands: ["system.which"],
            connectionGeneration: dispatch?.expectedConnId,
            pairingGeneration: dispatch?.expectedPairingGeneration,
            boundedProfileReadinessProven: true,
            runtimeReadinessProven: false,
            rustAuthorityProven: false,
            authority: "none",
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }

      const processResult = await rustResult;
      expect(processResult.status).toBe(0);
      expect(processResult.stderr).toBe("");
      const evidence = JSON.parse(processResult.stdout) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        ...acceptedCase.expected,
        deviceId: identity.deviceId,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        resultRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        result: { bins: { node: expect.any(String) } },
      });
      expect(evidence.requestId).toBe(evidence.resultRequestId);
    },
  );
});
