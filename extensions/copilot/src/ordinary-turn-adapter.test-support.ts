import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import type { AgentHarnessTurnAdapter } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { createCopilotIsolatedSessionRestrictions } from "./session-restrictions.js";

/** QA-only text adapter. This does not replace or register the shipping Copilot harness. */
export function createCopilotOrdinaryTurnAdapterForTest(params: {
  client: Pick<CopilotClient, "createSession">;
  model: string;
  provider?: SessionConfig["provider"];
  workspaceDir: string;
}): AgentHarnessTurnAdapter {
  return {
    async prepare({ assertActive, signal }) {
      assertActive();
      // Preparation owns no native resource: host admission or hooks can still reject the turn.
      return {
        replayAfterIndex: -1,
        includeBootstrap: true,
        async run(turn) {
          const history = turn.previousMessages.map((message) => {
            if (message.role !== "user" && message.role !== "assistant") {
              throw new Error("Copilot text adapter cannot replay tool history");
            }
            const content = message.content;
            if (typeof content === "string") {
              return { role: message.role, content };
            }
            if (content.some((part) => part.type !== "text")) {
              throw new Error("Copilot text adapter cannot replay non-text content");
            }
            return { role: message.role, content };
          });
          const prompt = history.length
            ? `Conversation context before this turn:\n${JSON.stringify(history)}\n\nCurrent turn:\n${turn.prompt}`
            : turn.prompt;
          assertActive();
          const session = await params.client.createSession({
            ...createCopilotIsolatedSessionRestrictions(),
            model: params.model,
            provider: params.provider,
            workingDirectory: params.workspaceDir,
            systemMessage: { mode: "replace", content: turn.developerInstructions ?? "" },
            streaming: true,
            onPermissionRequest: () => ({ kind: "reject" }),
          });
          let unsubscribe: (() => void) | undefined;
          let output = Promise.resolve();
          let abortRequest: Promise<void> | undefined;
          let failure: unknown;
          let sending = false;
          let closed = false;
          let inputTokens = 0;
          let outputTokens = 0;
          const chunks = new Map<string, string>();
          const requestAbort = () => {
            if (!sending || abortRequest) {
              return;
            }
            abortRequest = session.abort().catch((error: unknown) => {
              failure ??= error;
              // A lost transport cannot deliver native idle. Fail and join teardown;
              // a successful abort acknowledgement still does not settle the turn.
              complete();
            });
          };
          let complete!: () => void;
          const terminal = new Promise<void>((resolve) => {
            complete = resolve;
          });
          const emit = (text: string, reasoning = false) => {
            output = output
              .then(async () => {
                if (!closed && turn.eventGate.open && !signal.aborted) {
                  await turn.emit({ type: "text", text, reasoning });
                }
              })
              .catch((error: unknown) => {
                failure ??= error;
                requestAbort();
              });
          };
          try {
            assertActive();
            unsubscribe = session.on((event) => {
              if (closed || event.agentId !== undefined) {
                return;
              }
              switch (event.type) {
                case "assistant.message_delta": {
                  const { messageId, deltaContent } = event.data;
                  chunks.set(messageId, (chunks.get(messageId) ?? "") + deltaContent);
                  emit(deltaContent);
                  break;
                }
                case "assistant.message": {
                  const { messageId, content } = event.data;
                  const streamed = chunks.get(messageId) ?? "";
                  if (!content.startsWith(streamed) || event.data.toolRequests?.length) {
                    failure ??= new Error("Copilot text adapter received an unsupported response");
                    requestAbort();
                  } else if (content.length > streamed.length) {
                    emit(content.slice(streamed.length));
                  }
                  chunks.set(messageId, content);
                  break;
                }
                case "assistant.reasoning_delta":
                  emit(event.data.deltaContent, true);
                  break;
                case "assistant.usage":
                  inputTokens += event.data.inputTokens ?? 0;
                  outputTokens += event.data.outputTokens ?? 0;
                  break;
                case "session.error":
                  failure ??= new Error(event.data.message);
                  complete();
                  break;
                case "session.idle":
                  if (event.data.mode !== "autopilot") {
                    complete();
                  }
                  break;
              }
            });
            signal.addEventListener("abort", requestAbort, { once: true });
            assertActive();
            // The SDK acknowledges submission separately from native idle. Mark conservatively
            // before dispatch so an uncertain send cannot be treated as safe to replay.
            turn.markSubmitted();
            await session.send({ prompt });
            sending = true;
            if (signal.aborted || failure) {
              requestAbort();
            }
            await terminal;
            await output;
            if (failure) {
              throw failure;
            }
            return {
              cancelled: signal.aborted,
              permissionDenied: false,
              assistantIdempotencyKey: `copilot-text:${session.sessionId}:${turn.admissionEntryId}`,
              readUsage: async () => ({
                input: inputTokens,
                output: outputTokens,
                total: inputTokens + outputTokens,
              }),
            };
          } finally {
            closed = true;
            signal.removeEventListener("abort", requestAbort);
            unsubscribe?.();
            await output;
            await abortRequest;
            // Detach acknowledgement is part of this adapter's settlement, not host cleanup.
            await session.disconnect();
          }
        },
      };
    },
  };
}
