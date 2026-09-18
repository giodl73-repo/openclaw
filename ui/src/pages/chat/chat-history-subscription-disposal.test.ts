// @vitest-environment node

import type {
  ControlModel,
  ControlModelConversationOptions,
  ControlModelConversationSnapshot,
} from "@openclaw/gateway-client/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { loadControlModelChatHistory } from "./chat-history-control-model.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import type { ChatState } from "./chat-state-contract.ts";

const subscription = { key: "agent:main:main", agentId: null };

function createSubscriptionState(
  unsubscribeMessages: ReturnType<typeof vi.fn<SessionCapability["unsubscribeMessages"]>>,
  subscribeMessages: ReturnType<typeof vi.fn<SessionCapability["subscribeMessages"]>> = vi.fn<
    SessionCapability["subscribeMessages"]
  >(),
): ChatState {
  return {
    client: {} as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: subscription.key,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
    sessions: { subscribeMessages, unsubscribeMessages },
  };
}

describe("disposed chat message subscriptions", () => {
  afterEach(() => vi.useRealTimers());

  it("leases the shared Control Model conversation per pane so one disposal keeps the other", async () => {
    const snapshot = {
      sessionKey: subscription.key,
      history: { status: "ready" },
      metadata: null,
      messages: [],
      activeRun: null,
    } as unknown as ControlModelConversationSnapshot;
    const conversation = {
      getSnapshot: () => snapshot,
      refreshHistory: vi.fn(async () => undefined),
      loadMoreHistory: vi.fn(),
    };
    const acquire = vi.fn(
      (_sessionKey: string, _options?: ControlModelConversationOptions) => conversation,
    );
    const release = vi.fn(
      async (_sessionKey: string, _options?: ControlModelConversationOptions) => undefined,
    );
    const model = {
      conversation: acquire,
      releaseConversation: release,
    } as unknown as ControlModel;
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    // Two panes render the same session through one shared model.
    const first = createSubscriptionState(unsubscribeMessages);
    const second = createSubscriptionState(unsubscribeMessages);
    first.controlModel = model;
    second.controlModel = model;

    await loadControlModelChatHistory(first);
    await loadControlModelChatHistory(first);
    await loadControlModelChatHistory(second);

    const owners = acquire.mock.calls.map(([, options]) => options?.owner);
    expect(owners[0]).toBe(owners[1]);
    expect(owners[2]).not.toBe(owners[0]);
    expect(owners.every((owner) => typeof owner === "string" && owner.length > 0)).toBe(true);

    disposeSelectedSessionMessageSubscription(first);

    // Only the disposed pane's lease is released; the model owner keeps the
    // shared conversation alive for the pane that still renders it.
    expect(release).toHaveBeenCalledExactlyOnceWith(
      subscription.key,
      expect.objectContaining({ owner: owners[0] }),
    );
    expect(second.controlModelConversation).toBe(conversation);
  });

  it("releases an active message subscription when its pane is disposed", () => {
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscriptionRequestedKey = subscription.key;
    state.chatSessionMessageSubscription = subscription;
    state.chatSessionApprovalQueue = [
      {
        id: "approval-1",
        kind: "plugin",
        request: { command: "Approve", sessionKey: subscription.key },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    ];

    disposeSelectedSessionMessageSubscription(state);

    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBeNull();
    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(state.chatSessionApprovalQueue).toEqual([]);
  });

  it("releases a subscription that resolves after its pane is disposed", async () => {
    const pendingSubscription = createDeferred<typeof subscription>();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    const state = createSubscriptionState(
      unsubscribeMessages,
      vi.fn<SessionCapability["subscribeMessages"]>().mockReturnValue(pendingSubscription.promise),
    );

    const sync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();
    disposeSelectedSessionMessageSubscription(state);
    pendingSubscription.resolve(subscription);
    await sync;

    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });

  it("retries a temporary release failure without another pane synchronization", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValueOnce(new Error("temporary observer release failure"))
      .mockResolvedValueOnce(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(250);

    expect(unsubscribeMessages).toHaveBeenCalledTimes(2);
    expect(unsubscribeMessages).toHaveBeenLastCalledWith(subscription);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });

  it("bounds permanently failing releases without leaking retry timers", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValue(new Error("observer unavailable"));
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.runAllTimersAsync();

    expect(unsubscribeMessages).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });
});
