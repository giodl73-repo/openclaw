// @vitest-environment node

import { createControlModel } from "@openclaw/gateway-client/model";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createControlModelGatewayBridge } from "../../app/control-model-gateway.ts";
import { loadControlModelChatHistory } from "./chat-history-control-model.ts";
import { requestChatSend } from "./chat-send-request.ts";
import type { ChatState } from "./chat-state-contract.ts";

vi.mock("../../api/gateway.ts", () => ({
  GatewayRequestError: class GatewayRequestError extends Error {
    constructor(options: { message: string } & Record<string, unknown>) {
      super(options.message);
      Object.assign(this, options);
    }
  },
}));

const SESSION_KEY = "agent:main:proof";

describe("Control Model production boundary", () => {
  it("sends to the selected session and recovers input custody after reconnect", async () => {
    let phase = "connected";
    let epoch = 1;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.messages.subscribe") {
        return {
          key: SESSION_KEY,
          ...(params?.includeApprovals
            ? {
                approvalReplay: {
                  sessionKey: SESSION_KEY,
                  approvals: [],
                  truncated: false,
                },
              }
            : {}),
        };
      }
      if (method === "question.list") {
        return { questions: [] };
      }
      if (method === "chat.history") {
        return epoch === 1
          ? {
              messages: [],
              completeSnapshot: true,
              totalMessages: 0,
              sessionId: "session-proof",
              pendingInputs: {
                items: [{ runId: "pending-run", message: "queued before reconnect" }],
                total: 1,
              },
            }
          : {
              messages: [{ role: "user", content: "queued before reconnect" }],
              completeSnapshot: true,
              totalMessages: 1,
              sessionId: "session-proof",
              pendingInputs: { items: [], total: 0 },
              inputReceipts: [
                {
                  runId: "pending-run",
                  state: "consumed",
                  consumedByEventId: "event-after-reconnect",
                },
              ],
            };
      }
      if (method === "chat.send") {
        return { runId: "gateway-run", status: "accepted" };
      }
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      throw new Error(`Unexpected Gateway request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const bridge = createControlModelGatewayBridge({
      getGatewaySnapshot: () => ({ phase, lastError: null, lastErrorCode: null }),
      getConnectionEpoch: () => epoch,
      getClient: () => client,
      isCurrentClient: (candidate) => candidate === client,
      sessionMessageKeysEquivalent: (left, right) => left === right,
    });
    const model = createControlModel({
      gateway: bridge.binding,
      autoLoadConversationHistory: false,
    });
    model.start();
    const state = {
      client,
      connected: true,
      connectionEpoch: epoch,
      sessionKey: SESSION_KEY,
      currentSessionId: null,
      reconnectResumeSessionId: null,
      controlModel: model,
    } as unknown as ChatState;

    try {
      const initial = await loadControlModelChatHistory(state);
      expect(initial).toMatchObject({
        sessionId: "session-proof",
        pendingInputs: { items: [{ runId: "pending-run" }], total: 1 },
      });

      await expect(
        requestChatSend(state, { message: "selected route", runId: "selected-send" }),
      ).resolves.toMatchObject({ runId: "gateway-run", status: "started" });
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          sessionKey: SESSION_KEY,
          sessionId: "session-proof",
          message: "selected route",
          idempotencyKey: "selected-send",
          deliver: false,
        }),
        undefined,
      );

      const subscriptionsBeforeReconnect = request.mock.calls.filter(
        ([method]) => method === "sessions.messages.subscribe",
      ).length;
      phase = "reconnecting";
      bridge.notifyConnection();
      epoch = 2;
      state.connectionEpoch = epoch;
      phase = "connected";
      bridge.notifyConnection();

      await vi.waitFor(() => {
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.messages.subscribe").length,
        ).toBeGreaterThan(subscriptionsBeforeReconnect);
      });
      const recovered = await loadControlModelChatHistory(state, {
        inputRunIds: ["pending-run"],
      });

      expect(recovered).toMatchObject({
        pendingInputs: { items: [], total: 0 },
        inputReceipts: [
          {
            runId: "pending-run",
            state: "consumed",
            consumedByEventId: "event-after-reconnect",
          },
        ],
      });
      expect(recovered.messages).toContainEqual({
        role: "user",
        content: "queued before reconnect",
      });
      expect(request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: SESSION_KEY, inputRunIds: ["pending-run"] }),
        undefined,
      );
    } finally {
      model.dispose();
      bridge.dispose();
    }
  });
});
