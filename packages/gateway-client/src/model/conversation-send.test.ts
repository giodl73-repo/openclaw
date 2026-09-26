import { validateChatSendParams } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { activatedConversation } from "./conversation.test-support.js";

describe("Control Model send contract", () => {
  it.each(["run-guard", "", null, undefined])(
    "rejects an unsupported run guard before projection or dispatch (%#)",
    async (expectedRunId) => {
      const { harness, model, conversation } = await activatedConversation();
      const listener = vi.fn();
      const unsubscribe = conversation.subscribe(listener);
      listener.mockClear();
      const before = conversation.getSnapshot();
      // JavaScript callers can still supply a field removed from the typed contract.
      const input = { message: "guarded send", expectedRunId };
      try {
        await expect(conversation.send(input)).rejects.toMatchObject({
          category: "invalid-input",
          code: "UNSUPPORTED_SEND_OPTION",
          command: "chat.send",
        });
        expect(harness.callsFor("chat.send")).toHaveLength(0);
        expect(listener).not.toHaveBeenCalled();
        expect(conversation.getSnapshot()).toBe(before);
      } finally {
        unsubscribe();
        model.dispose();
      }
    },
  );

  it.each([null, "leaf-1"])(
    "preserves supported options and conforms to the Gateway schema with leaf %s",
    async (expectedLeafEntryId) => {
      const { harness, model, conversation } = await activatedConversation();
      const options = {
        thinking: "high",
        fastMode: "auto" as const,
        fastAutoOnSeconds: 30,
        queueMode: "steer",
        replyToId: "reply-1",
        timeoutMs: 10_000,
        expectedLeafEntryId,
        suppressCommandInterpretation: true,
      };
      const signal = new AbortController().signal;
      try {
        await expect(
          conversation.send(
            {
              message: "hello",
              idempotencyKey: "send-proof",
              ...options,
            },
            { signal },
          ),
        ).resolves.toMatchObject({ status: "accepted" });
        const calls = harness.callsFor("chat.send");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.params).toEqual({
          sessionKey: "agent:main:one",
          message: "hello",
          deliver: false,
          idempotencyKey: "send-proof",
          ...options,
        });
        expect(validateChatSendParams(calls[0]?.params)).toBe(true);
        expect(validateChatSendParams({ ...calls[0]?.params, expectedRunId: "run-guard" })).toBe(
          false,
        );
        expect(calls[0]?.options?.signal).toBe(signal);
      } finally {
        model.dispose();
      }
    },
  );
});
