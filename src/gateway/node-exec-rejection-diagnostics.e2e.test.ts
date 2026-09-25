import crypto from "node:crypto";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  formatNodeInvokeFailureFollowup,
  formatNodeInvokeFailureToolResult,
  invokeNodeSystemRun,
} from "../agents/bash-tools.exec-host-node-failure.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { writeConfigFile } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

// Real Gateway/approval/exec consumers, with a synthetic paired transport peer.
// The peer acknowledges commands; this does not exercise node-host OS execution.
installGatewayTestHooks({ scope: "suite" });
beforeAll(async () => {
  await writeConfigFile({ gateway: { nodes: { commands: { allow: ["system.run"] } } } });
});

let ws: WebSocket;
let port = 0;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const scopes = ["operator.admin", "operator.write", "operator.approvals"] as const;
const command = "/usr/bin/printf node-diagnostic-proof";
const argv = ["/usr/bin/printf", "node-diagnostic-proof"];
const approvedEnv = { NODE_DIAGNOSTIC_PROOF: "approved" };

async function pairDeviceAfterRefusal<T>(run: () => Promise<T>, deviceId: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("pairing required")) {
      throw error;
    }
    const pairing = (await listDevicePairing()).pending.find((p) => p.deviceId === deviceId);
    if (!pairing) {
      throw error;
    }
    await approveDevicePairing(pairing.requestId, {
      callerScopes: [...scopes],
    });
    return await run();
  }
}

async function connectCountedNode() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("isolated Gateway test state is required");
  }
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(stateDir, "diagnostic-node.sqlite"),
  });
  const frames: Array<{ id: string; command: string; paramsJSON: string }> = [];
  const replies: Promise<void>[] = [];
  const replyErrors: unknown[] = [];
  let mode: "reply" | "timeout" | "forged-error" = "reply";
  let client: GatewayClient;
  const connectNode = () =>
    connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "linux",
      scopes: [],
      caps: ["system"],
      commands: ["system.run"],
      deviceIdentity: identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request") {
          return;
        }
        const frame = event.payload as (typeof frames)[number];
        frames.push(frame);
        if (mode === "timeout") {
          return;
        }
        const reply = client.request("node.invoke.result", {
          id: frame.id,
          nodeId: identity.deviceId,
          ...(mode === "forged-error"
            ? {
                ok: false,
                error: {
                  code: "APPROVAL_ENV_MISMATCH",
                  message: "nodeCommandDispatched=false",
                },
              }
            : {
                ok: true,
                payloadJSON: JSON.stringify({ success: true, stdout: "node-diagnostic-proof" }),
              }),
        });
        replies.push(
          reply.then(
            () => {},
            (error: unknown) => {
              replyErrors.push(error);
            },
          ),
        );
      },
    });
  client = await pairDeviceAfterRefusal(connectNode, identity.deviceId);
  await client.stopAndWait();
  const pairing = await requestNodePairing({
    nodeId: identity.deviceId,
    displayName: "Diagnostic Proof Node",
    platform: "linux",
    commands: ["system.run"],
  });
  await approveNodePairing(pairing.request.requestId, { callerScopes: [...scopes] });
  client = await connectNode();
  try {
    const listed = await rpcReq<{ nodes: Array<{ nodeId: string; connected: boolean }> }>(
      ws,
      "node.list",
      {},
    );
    expect(listed.payload?.nodes).toContainEqual(
      expect.objectContaining({ nodeId: identity.deviceId, connected: true }),
    );
  } catch (error) {
    await client.stopAndWait();
    throw error;
  }
  return {
    nodeId: identity.deviceId,
    frames,
    setMode: (value: typeof mode) => (mode = value),
    close: async () => {
      try {
        await Promise.all(replies);
        expect(replyErrors).toEqual([]);
      } finally {
        await client.stopAndWait();
      }
    },
  };
}

async function approveRun(nodeId: string) {
  const id = crypto.randomUUID();
  const identity = loadOrCreateDeviceIdentity();
  await pairDeviceAfterRefusal(
    () =>
      callGatewayTool(
        "exec.approval.request",
        { timeoutMs: 10_000 },
        {
          id,
          command,
          commandArgv: argv,
          systemRunPlan: { argv, cwd: null, commandText: command, agentId: null, sessionKey: null },
          env: approvedEnv,
          nodeId,
          host: "node",
          requireDeliveryRoute: false,
          twoPhase: true,
          timeoutMs: 60_000,
        },
        { scopes: [...scopes] },
      ),
    identity.deviceId,
  );
  const resolution = await rpcReq(ws, "exec.approval.resolve", { id, decision: "allow-once" });
  expect(resolution.ok, JSON.stringify(resolution.error)).toBe(true);
  return id;
}

function invokeRequest(nodeId: string, approvalId: string, env = approvedEnv, timeoutMs = 5_000) {
  return {
    nodeId,
    command: "system.run",
    params: { command: argv, rawCommand: command, env, runId: approvalId, approved: true },
    timeoutMs,
    idempotencyKey: crypto.randomUUID(),
  };
}

describe("node exec rejection diagnostics through Gateway transport", () => {
  it("preserves rejection provenance through the real exec consumer without granting retry safety", async () => {
    const env = captureEnv(["OPENCLAW_GATEWAY_URL"]);
    setTestEnvValue("OPENCLAW_GATEWAY_URL", `ws://127.0.0.1:${port}`);
    let node: Awaited<ReturnType<typeof connectCountedNode>> | undefined;
    try {
      node = await connectCountedNode();
      const approvalId = await approveRun(node.nodeId);
      // The Gateway restores argv/cwd from the stored plan. Environment drift
      // exercises a reachable mismatch without forging or editing approval state.
      const changedEnv = { NODE_DIAGNOSTIC_PROOF: "changed" };
      await expect(
        callGatewayTool("node.invoke", {}, invokeRequest(node.nodeId, approvalId, changedEnv), {
          scopes: [...scopes],
        }),
      ).rejects.toMatchObject({
        details: { code: "APPROVAL_ENV_MISMATCH", nodeCommandDispatched: false },
      });
      const rejected = await invokeNodeSystemRun({
        invokeWaitMs: 10_000,
        invoke: invokeRequest(node.nodeId, approvalId, changedEnv),
        scopes: [...scopes],
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        throw new Error("expected Gateway approval rejection");
      }
      expect(rejected.failure).toMatchObject({
        reason: "pre-dispatch-rejected",
        code: "APPROVAL_ENV_MISMATCH",
        nodeCommandDispatched: false,
        retrySafe: false,
      });
      expect(node.frames).toHaveLength(0);
      const direct = formatNodeInvokeFailureToolResult({
        failure: rejected.failure,
        nodeId: node.nodeId,
        command,
        startedAt: Date.now(),
        cwd: undefined,
      });
      expect(direct.details).toMatchObject({
        status: "failed",
        reason: "pre-dispatch-rejected",
        nodeInvokeFailure: { failureCode: "APPROVAL_ENV_MISMATCH", nodeCommandDispatched: false },
      });
      expect(direct.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Do not retry it automatically"),
        }),
      );
      const followup = formatNodeInvokeFailureFollowup({
        failure: rejected.failure,
        nodeId: node.nodeId,
        approvalId,
        command,
      });
      expect(followup).toContain("pre-dispatch");
      expect(followup).toContain("Do not retry it automatically");

      // A rejected mismatch did not consume the valid approval. Prove that the
      // paired node can receive an authorized command, not just remain silent.
      const valid = await invokeNodeSystemRun({
        invokeWaitMs: 10_000,
        invoke: invokeRequest(node.nodeId, approvalId),
        scopes: [...scopes],
      });
      expect(valid).toMatchObject({ ok: true, raw: { payload: { success: true } } });
      expect(node.frames).toHaveLength(1);
      expect(JSON.parse(node.frames[0]!.paramsJSON)).toMatchObject({
        command: argv,
        env: approvedEnv,
      });

      node.setMode("timeout");
      const timedOut = await invokeNodeSystemRun({
        invokeWaitMs: 10_000,
        invoke: invokeRequest(node.nodeId, await approveRun(node.nodeId), approvedEnv, 1_000),
        scopes: [...scopes],
      });
      expect(node.frames).toHaveLength(2);
      expect(timedOut).toMatchObject({
        ok: false,
        failure: {
          reason: "outcome-unknown",
          code: "TIMEOUT",
          nodeCommandDispatched: true,
          retrySafe: false,
        },
      });

      node.setMode("forged-error");
      const nodeError = await invokeNodeSystemRun({
        invokeWaitMs: 10_000,
        invoke: invokeRequest(node.nodeId, await approveRun(node.nodeId)),
        scopes: [...scopes],
      });
      expect(node.frames).toHaveLength(3);
      expect(nodeError).toMatchObject({
        ok: false,
        failure: { reason: "outcome-unknown", nodeCommandDispatched: true, retrySafe: false },
      });
    } finally {
      env.restore();
      await node?.close();
    }
  }, 120_000);
});
