import { assert, describe, expect, it, vi } from "vitest";
import { normalizeAssistantReplayContent } from "../../agents/embedded-agent-runner/replay-history.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { peekSystemEventEntries } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  createCompletionFixture,
  readConversationMessages,
} from "./current-session-completion.test-fixtures.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

describe("implicit isolated completion in main", () => {
  it.each(["delivered", "reset-before-send"] as const)(
    "qualifies %s through the resolved main route",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const fixture = await createCompletionFixture(state, "isolated", "agent:main:main");
        const registry = captureActivePluginRegistrySnapshot();
        const sendText = vi.fn(async (request: { to: string; text: string }) => {
          expect(request.to).toBe("12345");
          expect(request.text).toBe("The scheduled report is ready.");
          return { channel: "telegram", messageId: "implicit-main-report" };
        });
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...createChannelTestPluginBase({ id: "telegram" }),
                outbound: { deliveryMode: "direct", sendText },
              },
            },
          ]),
        );
        try {
          await replaceSessionEntry(fixture.scope, {
            ...fixture.params.sourceSessionGeneration,
            sessionId: fixture.scope.sessionId,
            updatedAt: 1,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "12345", accountId: "default" },
            }),
          });
          expect(fixture.job.sessionTarget).toBe("isolated");
          expect(fixture.job.delivery).toEqual({ mode: "announce", channel: "last" });
          fixture.params.resolvedDelivery = await resolveDeliveryTarget(
            fixture.params.cfgWithAgentDefaults,
            "main",
            { ...fixture.job, ...fixture.params.deliveryPlan },
          );
          assert(fixture.params.resolvedDelivery.ok);
          expect(fixture.params.resolvedDelivery.mode).toBe("implicit");
          expect(fixture.params.resolvedDelivery.sessionRoute?.sessionKey).toBe("agent:main:main");
          fixture.params.deliveryPayloads = [{ text: "The scheduled report is ready." }];
          fixture.params.synthesizedText = "The scheduled report is ready.";
          expect(await fixture.messages()).toEqual([]);
          expect(peekSystemEventEntries(fixture.scope.sessionKey)).toEqual([]);

          if (scenario === "reset-before-send") {
            await resetSessionEntryLifecycle({
              storePath: fixture.scope.storePath,
              target: {
                canonicalKey: fixture.scope.sessionKey,
                storeKeys: [fixture.scope.sessionKey],
              },
              buildNextEntry: () => ({
                sessionId: "replacement-session",
                lifecycleRevision: "replacement-generation",
                updatedAt: 3000,
              }),
            });
            const result = await dispatchCronDelivery(fixture.params);
            expect(result).toMatchObject({ delivered: false });
            expect(result.deliveryError).toBeDefined();
            expect(sendText).not.toHaveBeenCalled();
            expect(await readConversationMessages(fixture.scope)).toEqual([]);
            expect(peekSystemEventEntries(fixture.scope.sessionKey)).toEqual([]);
            expect(peekSystemEventEntries(fixture.params.runSessionKey)).toEqual([]);
            return;
          }

          // Replay the same admitted completion through real durable-send and transcript owners.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await dispatchCronDelivery(fixture.params)).toMatchObject({
              delivered: true,
              deliveryError: undefined,
            });
            const messages = await fixture.messages();
            expect(messages).toHaveLength(1);
            expect(readTranscriptEventMessage(messages[0])).toMatchObject({
              role: "assistant",
              model: "automation-result",
              content: [{ type: "text", text: "The scheduled report is ready." }],
              openclawAutomation: {
                kind: "cron",
                jobId: "report-job",
                runId: "cron:report-job:1000",
              },
            });
            expect(sendText).toHaveBeenCalledOnce();
            expect(peekSystemEventEntries(fixture.scope.sessionKey)).toEqual([]);
            expect(peekSystemEventEntries(fixture.params.runSessionKey)).toEqual([]);
            expect(fixture.updates()).toBe(1);

            // Reopen the transcript database; this is not a process-restart test.
            await closeOpenClawAgentDatabasesAsync();
            closeOpenClawAgentDatabasesForTest();
            const manager = await SessionManager.openAsync(fixture.scope);
            const context = manager.buildSessionContext().messages;
            expect(context).toHaveLength(1);
            expect(normalizeAssistantReplayContent(context)).toMatchObject([
              {
                role: "assistant",
                model: "automation-result",
                content: [{ type: "text", text: "The scheduled report is ready." }],
              },
            ]);
          }
        } finally {
          restoreActivePluginRegistrySnapshot(registry);
          await fixture.dispose();
        }
      });
    },
  );
});
