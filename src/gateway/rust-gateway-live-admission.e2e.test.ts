import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { approveNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { startGatewayServer, type GatewayServer } from "./server.js";
import { getFreeGatewayPort } from "./test-helpers.e2e.js";

const MANIFEST = resolve("experiments/rust-gateway-live-admission/Cargo.toml");
const FIXTURE_PATH = resolve(".lobster/rust-gateway-live-admission-fixture.json");
const CARGO = resolveCargoExecutable();
const inferredCargoHome = isAbsolute(CARGO) ? resolve(dirname(CARGO), "..") : undefined;
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

type AdmissionFixture = {
  fixtureId: string;
  owner: {
    protocolVersion: number;
    minimumNodeProtocolVersion: number;
  };
  cases: Array<{
    id: string;
    input: { minProtocol: number; maxProtocol: number };
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

describe("Rust Gateway live admission", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AdmissionFixture;
  const acceptedCase = fixture.cases.find((entry) => entry.id === "current-protocol-admitted");
  const rejectedCase = fixture.cases.find((entry) => entry.id === "obsolete-protocol-refused");
  if (!acceptedCase || !rejectedCase) {
    throw new Error("Rust Gateway live admission fixture case inventory is incomplete");
  }
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-rust-gateway-canary-"));
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
    execFileSync(CARGO, ["build", "--locked", "--manifest-path", MANIFEST], {
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        ...cargoToolchainEnv,
        CARGO_TARGET_DIR: cargoTargetDir,
      },
    });
    identity = JSON.parse(
      execFileSync(binary, ["identity", identityPath], { encoding: "utf8" }),
    ) as PublicIdentity;
    const request = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        displayName: "Rust Gateway live admission",
        platform: "rust",
        clientId: "node-host",
        clientMode: "node",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: false,
      },
      stateDir,
    );
    const approval = await approveDevicePairing(request.request.requestId, stateDir);
    if (!approval || approval.status !== "approved") {
      throw new Error("failed to approve ephemeral Rust node identity");
    }
    const token = approval.device.tokens?.node?.token;
    if (!token) {
      throw new Error("approved Rust node identity has no node token");
    }
    deviceToken = token;
    const nodePairing = await requestNodePairing(
      {
        nodeId: identity.deviceId,
        displayName: "Rust Gateway live admission",
        platform: "rust",
        commands: [],
      },
      stateDir,
    );
    const nodeApproval = await approveNodePairing(
      nodePairing.request.requestId,
      { callerScopes: ["operator.pairing", "operator.admin"] },
      stateDir,
    );
    if (!nodeApproval || !("node" in nodeApproval)) {
      throw new Error("failed to approve empty Rust node capability surface");
    }
    const port = await getFreeGatewayPort();
    url = `ws://127.0.0.1:${port}`;
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "unused-shared-gateway-token" },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
  }, 120_000);

  afterAll(async () => {
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
    "admits a current-protocol Rust node without command or effect authority",
    { timeout: 600_000 },
    async () => {
      const result = await runBinary(
        binary,
        [
          "connect",
          url,
          identityPath,
          String(acceptedCase.input.minProtocol),
          String(acceptedCase.input.maxProtocol),
        ],
        {
          ...process.env,
          OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ...acceptedCase.expected,
        deviceId: identity.deviceId,
      });
      const paired = await getPairedDevice(identity.deviceId, stateDir);
      expect(paired).toMatchObject({
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        role: "node",
      });
    },
  );

  it("fails closed when the Rust node offers obsolete protocol v1", async () => {
    const result = await runBinary(
      binary,
      [
        "connect",
        url,
        identityPath,
        String(rejectedCase.input.minProtocol),
        String(rejectedCase.input.maxProtocol),
      ],
      {
        ...process.env,
        OPENCLAW_RUST_CANARY_DEVICE_TOKEN: deviceToken,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ...rejectedCase.expected,
      deviceId: identity.deviceId,
    });
  });

  it("never writes credentials into the public identity output", () => {
    const storedIdentity = readFileSync(identityPath, "utf8");
    expect(identity).toEqual({
      deviceId: expect.stringMatching(/^[0-9a-f]{64}$/),
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(identity)).not.toContain(deviceToken);
    expect(storedIdentity).not.toContain(deviceToken);
  });
});
