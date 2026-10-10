import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { CronRunLogEntry } from "../../../../packages/gateway-protocol/src/index.js";
import type { CronEvent } from "../../../../src/cron/service/state.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing,
  createChildEnv,
  startNodeProcess,
  stopChild,
  waitForNode,
  type CapturedChild,
} from "./gateway-node-mcp.test-support.js";
import { startNodeDispatchGate } from "./node-exec-fatal-cron-dispatch-gate.proof-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MODEL = "mock-openai/proof-model";
const DENIAL = "SYSTEM_RUN_DISABLED: security=deny";
const CALL_ID = "call_scheduled_node_denial";

function writeExecCall(response: ServerResponse, command: string) {
  const args = JSON.stringify({ command });
  const item = {
    type: "function_call",
    id: "fc_scheduled_node_denial",
    call_id: CALL_ID,
    name: "exec",
    arguments: args,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      name: item.name,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_scheduled_node_denial",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startProvider(command: string, signal: AbortSignal) {
  const requests: Array<"exec" | "answer"> = [];
  const errors: unknown[] = [];
  const outputs: unknown[] = [];
  const owned = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
            tools?: Array<{ name?: string }>;
          };
          const result = body.input?.find(
            (item) => item.type === "function_call_output" && item.call_id === CALL_ID,
          );
          if (result) {
            outputs.push(result.output);
            requests.push("answer");
            writeOpenAiResponsesText(response, {
              text: "The node denied execution.",
              messageId: "msg_scheduled_node_denial",
              responseId: "resp_scheduled_node_answer",
            });
          } else {
            expect(requests).toEqual([]);
            expect(body.tools?.some((tool) => tool.name === "exec")).toBe(true);
            requests.push("exec");
            writeExecCall(response, command);
          }
        })().catch((error: unknown) => {
          errors.push(error);
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end("Synthetic provider fixture failed");
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${owned.claim.port}/v1`,
    requests,
    errors,
    outputs,
    stop: () =>
      runQaGatewayFixture(
        async () => {
          owned.listener.closeAllConnections();
          await owned.releaseListener();
        },
        () => owned.claim.release(),
      ),
  };
}

// This long, built-process composition is opt-in product proof, not a unit/PR lane.
describe.runIf(process.env.OPENCLAW_NODE_DENIAL_SCHEDULED_PROOF === "1")(
  "scheduled native node denial",
  () => {
    it(
      "retains the failed scheduled run across a Gateway restart",
      { timeout: 420_000 },
      async ({ signal }) => {
        expect(process.platform).toBe("linux");
        const repoRoot = process.cwd();
        const root = tempDirs.make("openclaw-scheduled-node-denial-");
        const marker = path.join(root, "must-not-exist.txt");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = `/usr/bin/touch ${quote(marker)}`;
        const owner = createQaGatewayChild();
        const children: CapturedChild[] = [];
        let observer: GatewayClient | undefined;
        let dispatch: Awaited<ReturnType<typeof startNodeDispatchGate>> | undefined;
        const provider = await startProvider(command, signal);
        await runQaGatewayFixture(
          async () => {
            const gateway = await owner.start({
              repoRoot,
              command: {
                executablePath: process.execPath,
                argsPrefix: ["dist/index.js"],
                cwd: repoRoot,
                usePackagedPlugins: true,
              },
              providerMode: "mock-openai",
              providerBaseUrl: provider.baseUrl,
              primaryModel: MODEL,
              alternateModel: MODEL,
              transportBaseUrl: "http://127.0.0.1",
              controlUiEnabled: false,
              runtimeEnvPatch: {
                OPENCLAW_SKIP_CHANNELS: "1",
                OPENCLAW_SKIP_PROVIDERS: "1",
                OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
              },
              mutateConfig: (cfg) => ({
                ...cfg,
                cron: { ...cfg.cron, enabled: true },
                tools: {
                  ...cfg.tools,
                  toolSearch: false,
                  codeMode: false,
                  exec: { host: "node", mode: "full" },
                },
                gateway: {
                  ...cfg.gateway,
                  nodes: {
                    commands: {
                      allow: [
                        "system.run",
                        "system.run.prepare",
                        "system.execApprovals.get",
                        "system.execApprovals.set",
                      ],
                    },
                    pairing: { autoApproveLocal: false, sshVerify: false },
                  },
                },
              }),
            });
            expect(gateway.runtimeEnv.OPENCLAW_SKIP_CRON).toBeUndefined();
            expect(await gateway.call("cron.status", {})).toMatchObject({ enabled: true });

            const home = path.join(root, "node-home");
            const state = path.join(root, "node-state");
            const tmp = path.join(root, "node-tmp");
            const config = path.join(root, "node.json");
            await Promise.all([home, state, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
            // Preparation must pass. The gate tightens native policy before run dispatch.
            await fs.writeFile(
              config,
              JSON.stringify({
                gateway: { mode: "local" },
                plugins: { enabled: false },
                tools: { exec: { mode: "full" } },
                nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
              }),
            );
            const env = createChildEnv({
              home,
              tempDir: tmp,
              extra: {
                OPENCLAW_HOME: home,
                OPENCLAW_STATE_DIR: state,
                OPENCLAW_CONFIG_PATH: config,
                OPENCLAW_GATEWAY_TOKEN: gateway.token,
                OPENCLAW_SKIP_CHANNELS: "1",
                OPENCLAW_SKIP_PROVIDERS: "1",
              },
            });
            let pairedNodeId: string | undefined;
            let revocations = 0;
            dispatch = await startNodeDispatchGate({
              gatewayUrl: gateway.wsUrl,
              signal,
              beforeRun: async (invoke) => {
                expect(invoke.nodeId).toBe(pairedNodeId);
                expect(revocations++).toBe(0);
                const snapshot = (await gateway.call("exec.approvals.node.get", {
                  nodeId: invoke.nodeId,
                })) as { hash: string };
                expect(snapshot.hash).toEqual(expect.any(String));
                await gateway.call("exec.approvals.node.set", {
                  nodeId: invoke.nodeId,
                  baseHash: snapshot.hash,
                  file: { version: 1, defaults: { security: "deny", ask: "off" }, agents: {} },
                });
                expect(
                  await gateway.call("exec.approvals.node.get", { nodeId: invoke.nodeId }),
                ).toMatchObject({
                  file: { defaults: { security: "deny", ask: "off" } },
                });
              },
            });
            const port = dispatch.port;
            const first = startNodeProcess(port, env);
            children.push(first);
            const nodeId = await approvePairing(gateway, "device");
            pairedNodeId = nodeId;
            await stopChild(first);
            children.push(startNodeProcess(port, env));
            await approvePairing(gateway, "node", nodeId);
            await waitForNode(gateway, nodeId);

            const terminal = createDeferred<CronEvent>();
            const events: CronEvent[] = [];
            const jobName = "Scheduled native node denial proof";
            observer = await acquireGatewayTestClient(
              {
                url: gateway.wsUrl,
                token: gateway.token,
                env: gateway.runtimeEnv,
                clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
                mode: GATEWAY_CLIENT_MODES.BACKEND,
                scopes: ["operator.admin"],
                deviceIdentity: null,
                onEvent: (frame) => {
                  if (frame.event !== "cron") {
                    return;
                  }
                  const event = frame.payload as CronEvent;
                  events.push(event);
                  if (event.action === "finished" && event.job?.name === jobName) {
                    terminal.resolve(event);
                  }
                },
              },
              {
                timeoutMs: 30_000,
                timeoutMessage: "Cron observer failed to connect",
                closeMessage: "Cron observer closed before hello",
                signal,
              },
            );
            // A due timer, never cron.run. This fixture owns the only job and node.
            const due = Date.now() + 2_000;
            const added = (await gateway.call("cron.add", {
              name: jobName,
              agentId: "qa",
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: "at", at: new Date(due).toISOString() },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: {
                kind: "agentTurn",
                message: "Execute the proof command once, then report the outcome.",
                model: MODEL,
                timeoutSeconds: 60,
              },
              delivery: { mode: "none" },
            })) as { id: string };
            const finished = await withinTest(terminal.promise, signal);
            expect(finished.jobId).toBe(added.id);
            expect(finished.runAtMs).toBeGreaterThanOrEqual(due);
            expect(finished).toMatchObject({ status: "error", error: DENIAL, summary: DENIAL });
            expect(
              events.filter((event) => event.jobId === added.id && event.action === "finished"),
            ).toHaveLength(1);
            expect(provider.errors).toEqual([]);
            expect(dispatch.errors).toEqual([]);
            expect(revocations).toBe(1);
            const execInvokes = dispatch.invokes.filter(
              (invoke) =>
                invoke.command === "system.run.prepare" || invoke.command === "system.run",
            );
            expect(execInvokes.map((invoke) => invoke.command)).toEqual([
              "system.run.prepare",
              "system.run",
            ]);
            expect(
              dispatch.results.find((result) => result.id === execInvokes[1].id),
            ).toMatchObject({
              nodeId,
              ok: false,
              error: { code: "SYSTEM_RUN_DENIED", message: DENIAL },
            });
            expect(provider.requests).toEqual(["exec", "answer"]);
            expect(JSON.stringify(provider.outputs)).toContain(DENIAL);
            await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

            const before = (await gateway.call("cron.runs", { id: added.id, limit: 10 })) as {
              entries: CronRunLogEntry[];
            };
            expect(before.entries).toHaveLength(1);
            const entry = before.entries[0];
            expect(entry).toMatchObject({
              jobId: added.id,
              runAtMs: finished.runAtMs,
              sessionId: finished.sessionId,
              status: "error",
              error: DENIAL,
              summary: DENIAL,
              diagnostics: {
                entries: expect.arrayContaining([
                  expect.objectContaining({
                    source: "tool",
                    severity: "error",
                    toolName: "exec",
                    code: "SYSTEM_RUN_DENIED",
                  }),
                ]),
              },
            });
            expect(entry.sessionId).toEqual(expect.any(String));
            const jobBefore = await gateway.call("cron.get", { id: added.id });
            await observer.stopAndWait();
            observer = undefined;
            await gateway.restartAfterStateMutation(async () => {});
            await waitForNode(gateway, nodeId);
            const after = (await gateway.call("cron.runs", { id: added.id, limit: 10 })) as {
              entries: CronRunLogEntry[];
            };
            expect(after.entries).toEqual(before.entries);
            expect(await gateway.call("cron.get", { id: added.id })).toEqual(jobBefore);
            await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
          },
          async () => {
            const results = await Promise.allSettled(children.map((child) => stopChild(child)));
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length) {
              throw new AggregateError(failures, "Native denial node cleanup failed");
            }
          },
          () => observer?.stopAndWait(),
          () => dispatch?.stop(),
          () => stopQaGatewayFixture(owner),
          () => provider.stop(),
        );
      },
    );
  },
);
