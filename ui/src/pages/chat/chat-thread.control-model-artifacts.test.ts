// @vitest-environment node
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  activatedConversation,
  createHarness,
} from "../../../../packages/gateway-client/src/model/conversation.test-support.js";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { buildChatItems } from "./chat-thread-build.ts";

const sessionKey = "agent:main:one";
const urls = ["/__openclaw__/canvas/one.html", "/__openclaw__/canvas/two.html"];

describe("Control Model artifacts through transcript construction", () => {
  it.each<{
    reverse: boolean;
    liveDuplicate: boolean;
    historical?: boolean;
    embedded?: boolean;
    equivalent?: boolean;
  }>([
    { reverse: false, liveDuplicate: false },
    { reverse: true, liveDuplicate: false },
    { reverse: false, liveDuplicate: true },
    { reverse: true, liveDuplicate: true },
    { reverse: false, liveDuplicate: false, historical: true },
    { reverse: false, liveDuplicate: false, embedded: true },
    { reverse: false, liveDuplicate: false, equivalent: true },
    { reverse: true, liveDuplicate: true, equivalent: true },
  ])(
    "retains sibling views from one tool result (%j)",
    async ({ reverse, liveDuplicate, historical, embedded, equivalent }) => {
      const viewUrls = equivalent ? [urls[0], urls[0]] : urls;
      const artifacts = viewUrls.map((url, index) => ({
        version: 1,
        id: `artifact-${index}`,
        revision: 1,
        state: "ready",
        source: {
          sessionKey,
          messageId: "tool-result",
          toolCallId: "tool-call",
          toolName: "canvas",
        },
        views: [
          {
            id: `view-${index}`,
            templateUri: "openclaw://canvas",
            dataVersion: 1,
            availability: "deferred",
            fallback: {
              kind: "canvas",
              url,
              sandbox: index === 0 || equivalent ? "strict" : "scripts",
            },
          },
        ],
      }));
      const toolResult = {
        role: "toolResult",
        __openclaw: { id: "tool-result", seq: 2 },
        toolCallId: "tool-call",
        toolName: "canvas",
        timestamp: 2_000,
        content: JSON.stringify({ kind: "canvas", view: { url: urls[0], title: "First view" } }),
        details: { uiArtifacts: artifacts },
      };
      const messages = [
        { role: "user", content: "Show both views", timestamp: 1_000 },
        toolResult,
        {
          role: "assistant",
          content: embedded
            ? [
                { type: "text", text: "Both views" },
                {
                  type: "canvas",
                  preview: {
                    kind: "canvas",
                    surface: "assistant_message",
                    render: "url",
                    url: urls[1],
                    sandbox: "scripts",
                  },
                },
              ]
            : "Both views",
          timestamp: 3_000,
        },
        ...(historical
          ? [
              { role: "user", content: "Next request", timestamp: 4_000 },
              { role: "assistant", content: "New turn", timestamp: 5_000 },
            ]
          : []),
      ];
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        {
          history: { messages, completeSnapshot: true },
        },
      );
      const { model, conversation } = await activatedConversation(harness);
      try {
        const projected = conversation.getSnapshot().artifacts;
        expect(projected).toHaveLength(2);
        expect(projected.map((artifact) => artifact.error)).toEqual([undefined, undefined]);
        expect(projected.every((artifact) => artifact.state === "ready")).toBe(true);
        const items = buildChatItems({
          paneId: "artifact-proof",
          sessionKey,
          runId: historical ? "next-run" : null,
          messages,
          toolMessages: liveDuplicate ? [toolResult] : [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          showToolCalls: true,
          controlModelArtifacts: reverse ? projected.toReversed() : projected,
        });
        const previews = items.flatMap((item) =>
          item.kind === "group"
            ? item.messages.flatMap(({ message }) =>
                normalizeMessage(message)
                  .content.map(asRecord)
                  .filter((block) => block?.type === "canvas")
                  .map((block) => asRecord(block?.preview)),
              )
            : [],
        );
        expect(previews).toHaveLength(equivalent ? 1 : 2);
        const keys = items.flatMap((item) =>
          item.kind === "group" ? item.messages.map((message) => message.key) : [item.key],
        );
        expect(new Set(keys).size).toBe(keys.length);
        expect(previews).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ url: urls[0], sandbox: "strict", title: "First view" }),
            ...(equivalent ? [] : [expect.objectContaining({ url: urls[1], sandbox: "scripts" })]),
          ]),
        );
        expect(previews.find((preview) => preview?.url === urls[1])?.title).not.toBe("First view");
        if (historical) {
          const rendered = items.flatMap((item) =>
            item.kind === "group"
              ? item.messages.map(({ message }) => normalizeMessage(message))
              : [],
          );
          const nextTurn = rendered.findIndex((message) =>
            message.content.some((block) => block.type === "text" && block.text === "Next request"),
          );
          expect(nextTurn).toBeGreaterThan(-1);
          expect(
            rendered
              .slice(nextTurn)
              .flatMap((message) => message.content)
              .filter((block) => block.type === "canvas"),
          ).toEqual([]);
        }
      } finally {
        model.dispose();
      }
    },
  );
});
