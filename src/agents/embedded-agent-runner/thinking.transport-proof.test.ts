import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { createAnthropicMessagesTransportStreamFn } from "@openclaw/ai/transports";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { wrapAnthropicStreamWithRecovery } from "./thinking.js";

const signature = "c3ludGhldGljLXNpZ25hdHVyZQ==";
const error = { type: "invalid_request_error", message: "thinking signature invalid" };

function responseEvents(failAfterOutput: boolean) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_transport_proof",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Recovered over HTTP." },
    },
    { type: "content_block_stop", index: 0 },
    ...(failAfterOutput
      ? [{ type: "error", error }]
      : [
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ]),
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

describe("promised thinking recovery through the native HTTP transport", () => {
  it.each(["recover", "after-output", "retry-limit"] as const)("%s", async (scenario) => {
    const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
    const repairStarted = createDeferred();
    const releaseRepair = createDeferred();
    const controller = new AbortController();
    let claim: TestPortClaim | undefined;
    let serverError: unknown;
    const previousHost = getAiTransportHost();
    // Keep the real transport and platform fetch; only the remote endpoint is synthetic.
    configureAiTransportHost({ ...previousHost, buildModelFetch: () => globalThis.fetch });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
          if (scenario === "retry-limit" || (scenario === "recover" && requests.length === 1)) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ type: "error", error }));
          } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(responseEvents(scenario === "after-output"));
          }
        } catch (error) {
          serverError = error;
          response.writeHead(500);
          response.end();
        }
      });
    });
    const pending: Promise<unknown>[] = [];
    try {
      claim = await acquireTestPortBlock({ offsets: [0], signal: controller.signal });
      const port = claim.port;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback TCP listener");
      }
      const model: Model<"anthropic-messages"> = {
        id: "synthetic-anthropic",
        name: "Synthetic transport proof",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${address.port}`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      };
      const context: Context = {
        messages: [
          { role: "user", content: "Synthetic earlier request", timestamp: 1 },
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              { type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: signature },
              { type: "text", text: "Synthetic earlier response" },
            ],
            stopReason: "stop",
            usage: createZeroUsageFixture(),
            timestamp: 2,
          },
          { role: "user", content: "Synthetic next request", timestamp: 3 },
        ],
      };
      const transport = createAnthropicMessagesTransportStreamFn();
      const repaired = vi.fn(async () => {
        repairStarted.resolve();
        await releaseRepair.promise;
      });
      const streamFn = wrapAnthropicStreamWithRecovery(
        (selected, messages, options) => Promise.resolve(transport(selected, messages, options)),
        { id: "synthetic-http-recovery", onRecoveredAnthropicThinking: repaired },
      );
      const response = await withTestTimeout(
        Promise.resolve(
          streamFn(model, context, {
            apiKey: "synthetic-transport-token",
            reasoning: "low",
            signal: controller.signal,
          }),
        ),
        5000,
        "Transport stream did not initialize",
      );
      const events: string[] = [];
      let eventsSettled = false;
      let resultSettled = false;
      const draining = (async () => {
        for await (const event of response) {
          events.push(event.type);
        }
        eventsSettled = true;
      })();
      const result = response.result().then((message) => {
        resultSettled = true;
        return message;
      });
      pending.push(draining, result);
      for (const work of pending) {
        void work.catch(() => {});
      }
      if (scenario === "recover") {
        expect(
          await withTestTimeout(
            Promise.race([repairStarted.promise.then(() => "repair"), result.then(() => "result")]),
            5000,
            "Recovery did not reach repair",
          ),
        ).toBe("repair");
        // Let queued completion continuations run while repair remains blocked.
        await setImmediate();
        expect(eventsSettled).toBe(false);
        expect(resultSettled).toBe(false);
        expect(events).not.toContain("done");
        releaseRepair.resolve();
      }
      const [message] = await withTestTimeout(
        Promise.all([result, draining]),
        5000,
        "Transport recovery did not settle",
      );
      expect(serverError).toBeUndefined();
      expect(message.stopReason).toBe(scenario === "recover" ? "stop" : "error");
      if (scenario === "recover") {
        expect(message.content).toEqual([{ type: "text", text: "Recovered over HTTP." }]);
      } else {
        expect(message.errorMessage).toMatch(/thinking.*signature/i);
      }
      expect(repaired).toHaveBeenCalledTimes(scenario === "recover" ? 1 : 0);
      expect(requests).toHaveLength(scenario === "after-output" ? 1 : 2);
      for (const request of requests) {
        expect(request).toMatchObject({
          method: "POST",
          url: "/v1/messages",
          body: { model: model.id, stream: true },
        });
      }
      const thinkingHistory = {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "thinking", signature }),
            ]),
          }),
        ]),
      };
      expect(requests[0].body).toMatchObject(thinkingHistory);
      if (requests[1]) {
        expect(requests[1].body).not.toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([expect.objectContaining({ type: "thinking" })]),
            }),
          ]),
        });
      }
      if (scenario === "after-output") {
        expect(events).toContain("text_delta");
      }
      expect(events.at(-1)).toBe(scenario === "recover" ? "done" : "error");
    } finally {
      try {
        releaseRepair.resolve();
        controller.abort();
        const closing = server.listening
          ? new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            })
          : Promise.resolve();
        server.closeAllConnections();
        try {
          await withTestTimeout(
            Promise.all([closing, Promise.allSettled(pending)]),
            1000,
            "Transport proof cleanup did not settle",
          );
        } finally {
          await claim?.release();
        }
      } finally {
        configureAiTransportHost(previousHost);
      }
    }
  });
});
