import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resolvePromptBuildHookResult } from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

vi.mock("../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
});

describe.each(["embedded", "external"] as const)("%s prompt-hook sequence", (engine) => {
  const calls: string[] = [];
  const messages = [{ role: "user", content: "earlier" }];

  beforeEach(() => {
    calls.length = 0;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => {
            calls.push("heartbeat");
            return { prependContext: "heartbeat prefix", appendContext: "heartbeat suffix" };
          },
        },
        {
          hookName: "before_prompt_build",
          handler: (event) => {
            calls.push("prompt");
            expect(event).toMatchObject({ prompt: "hello", messages });
            return {
              prependContext: "prompt prefix",
              appendContext: "prompt suffix",
              systemPrompt: "hook system",
              toolsAllow: [],
            };
          },
        },
      ]),
    );
  });

  function build(trigger: "heartbeat" | "user" | undefined) {
    const ctx = { trigger, agentId: "qa", sessionKey: "agent:qa:main" };
    return engine === "embedded"
      ? resolvePromptBuildHookResult({
          config: {},
          prompt: "hello",
          messages,
          hookCtx: ctx,
          hookRunner: getGlobalHookRunner(),
        })
      : resolveAgentHarnessBeforePromptBuildResult({
          prompt: "hello",
          developerInstructions: "base",
          messages,
          ctx,
        });
  }

  it.each(["heartbeat", "user", undefined] as const)(
    "gates heartbeat contributions and preserves prompt fields (trigger=%s)",
    async (trigger) => {
      const result = await build(trigger);
      const heartbeat = trigger === "heartbeat";
      expect(calls).toEqual(heartbeat ? ["heartbeat", "prompt"] : ["prompt"]);
      expect(result).toMatchObject({ toolsAllow: [] });
      const prefix = heartbeat ? "heartbeat prefix\n\nprompt prefix" : "prompt prefix";
      const suffix = heartbeat ? "heartbeat suffix\n\nprompt suffix" : "prompt suffix";
      expect(result).toMatchObject(
        engine === "embedded"
          ? {
              prependContext: prefix,
              appendContext: suffix,
              systemPrompt: "hook system",
              hasPendingNonPromptBuildContext: heartbeat,
              decisionPromptBuildFields: {
                prependContext: "prompt prefix",
                appendContext: "prompt suffix",
                systemPrompt: "hook system",
              },
            }
          : {
              prompt: `${prefix}\n\nhello\n\n${suffix}`,
              developerInstructions: "hook system",
              promptInputRange: { start: prefix.length + 2, end: prefix.length + 7 },
            },
      );
    },
  );

  it("awaits the heartbeat before invoking prompt-build once", async () => {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const runner = getGlobalHookRunner()!;
    const heartbeat = vi
      .spyOn(runner, "runHeartbeatPromptContribution")
      .mockImplementation(async () => {
        entered.resolve();
        await released.promise;
        return { prependContext: "heartbeat prefix" };
      });
    const prompt = vi.spyOn(runner, "runBeforePromptBuild");
    const pending = build("heartbeat");
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "heartbeat was not reached");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await pending;
    }
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it.each(["runHeartbeatPromptContribution", "runBeforePromptBuild"] as const)(
    "preserves best-effort dispatch after %s rejects",
    async (method) => {
      vi.spyOn(getGlobalHookRunner()!, method).mockRejectedValue(new Error("synthetic failure"));
      const result = await build("heartbeat");
      const heartbeatFailed = method === "runHeartbeatPromptContribution";
      expect(calls).toEqual(heartbeatFailed ? ["prompt"] : ["heartbeat"]);
      expect(result).toMatchObject(
        engine === "embedded"
          ? {
              prependContext: heartbeatFailed ? "prompt prefix" : "heartbeat prefix",
              appendContext: heartbeatFailed ? "prompt suffix" : "heartbeat suffix",
              systemPrompt: heartbeatFailed ? "hook system" : undefined,
            }
          : {
              prompt: heartbeatFailed
                ? "prompt prefix\n\nhello\n\nprompt suffix"
                : "heartbeat prefix\n\nhello\n\nheartbeat suffix",
              developerInstructions: heartbeatFailed ? "hook system" : "base",
            },
      );
    },
  );

  it.each([false, true])(
    "preserves hook-presence timing when heartbeat changes availability (initial=%s)",
    async (initial) => {
      const runner = getGlobalHookRunner()!;
      let available = initial;
      vi.spyOn(runner, "hasHooks").mockImplementation(
        (name) =>
          name === "heartbeat_prompt_contribution" || (name === "before_prompt_build" && available),
      );
      vi.spyOn(runner, "runHeartbeatPromptContribution").mockImplementation(async () => {
        available = !initial;
        return undefined;
      });
      const prompt = vi.spyOn(runner, "runBeforePromptBuild");
      await build("heartbeat");
      expect(prompt).toHaveBeenCalledTimes((engine === "external" ? initial : !initial) ? 1 : 0);
    },
  );
});

it("retains external presence decisions made before awaiting history", async () => {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_prompt_build", handler: () => undefined }]),
  );
  const runner = getGlobalHookRunner()!;
  let available = true;
  vi.spyOn(runner, "hasHooks").mockImplementation(
    (name) => name === "before_prompt_build" && available,
  );
  const prompt = vi.spyOn(runner, "runBeforePromptBuild");
  const messages = [{ role: "user", content: "history" }];
  await resolveAgentHarnessBeforePromptBuildResult({
    prompt: "hello",
    developerInstructions: "base",
    messages: async () => {
      available = false;
      return messages;
    },
    ctx: {},
  });
  expect(prompt).toHaveBeenCalledExactlyOnceWith({ prompt: "hello", messages }, {});
});

it("checks embedded hook presence after turn preparation", async () => {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_prompt_build", handler: () => undefined }]),
  );
  const runner = getGlobalHookRunner()!;
  let prepared = false;
  vi.spyOn(runner, "hasHooks").mockImplementation(
    (name) => name === "agent_turn_prepare" || (name === "before_prompt_build" && prepared),
  );
  vi.spyOn(runner, "runAgentTurnPrepare").mockImplementation(async () => {
    prepared = true;
    return { prependContext: "prepared" };
  });
  const prompt = vi.spyOn(runner, "runBeforePromptBuild");
  const result = await resolvePromptBuildHookResult({
    config: {},
    prompt: "hello",
    messages: [],
    hookCtx: {},
    hookRunner: runner,
  });
  expect(prompt).toHaveBeenCalledOnce();
  expect(result.prependContext).toBe("prepared");
});
