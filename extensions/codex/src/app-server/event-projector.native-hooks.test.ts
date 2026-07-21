import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  initializeGlobalHookRunner,
  createMockPluginRegistry,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  requireRecord,
  mockCallArg,
  forCurrentTurn,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool hook projection", () => {
  it("emits after_tool_call observations for Codex-native tool item completions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector({
      ...(await createParams()),
      agentId: "main",
      sessionKey: "agent:main:session-1",
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("bash");
    expect(event.params).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("cmd-observed");
    expect(event.result).toEqual({
      status: "completed",
      exitCode: 0,
      durationMs: 42,
      output: "ok",
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(42);
    const context = requireRecord(
      mockCallArg(afterToolCall, 0, 1, "after_tool_call context"),
      "after_tool_call context",
    );
    expect(context.agentId).toBe("main");
    expect(context.sessionId).toBe("session-1");
    expect(context.sessionKey).toBe("agent:main:session-1");
    expect(context.runId).toBe("run-1");
    expect(context.toolName).toBe("bash");
    expect(context.toolCallId).toBe("cmd-observed");
  });

  it("omits after_tool_call startedAt when native duration is out of range", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-huge-duration",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: Number.MAX_SAFE_INTEGER,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.result).toEqual({
      status: "completed",
      exitCode: 0,
      durationMs: Number.MAX_SAFE_INTEGER,
      output: "ok",
    });
    expect(event).not.toHaveProperty("durationMs");
  });

  it("uses structured projection for shell items and relay projection for MCP items", async () => {
    const afterToolCall = vi.fn();
    const nativeRelayContexts = new Map([
      [
        "cmd-relayed",
        {
          toolName: "exec" as const,
          startArgs: { command: "pnpm test extensions/codex" },
          cwd: "/workspace",
          channelId: "target",
        },
      ],
      [
        "cmd-relayed-failed",
        {
          toolName: "exec" as const,
          startArgs: { command: 'node -e "process.exit(7)"' },
          cwd: "/workspace",
          channelId: "target",
        },
      ],
      [
        "patch-relayed",
        {
          toolName: "apply_patch" as const,
          startArgs: { command: "*** Begin Patch\n*** End Patch" },
          channelId: "target",
        },
      ],
    ]);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(
      { ...(await createParams()), sessionKey: "agent:main:session-1" },
      {
        nativePostToolUseRelayEnabled: true,
        consumeNativePostToolUseContext: (toolCallId) => {
          const context = nativeRelayContexts.get(toolCallId);
          nativeRelayContexts.delete(toolCallId);
          return context;
        },
      },
    );

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-relayed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );
    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const commandEvent = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "command after_tool_call event"),
      "command after_tool_call event",
    );
    expect(commandEvent.toolName).toBe("exec");
    expect(commandEvent.params).toEqual({ command: "pnpm test extensions/codex" });
    expect(commandEvent.result).toEqual({
      status: "completed",
      exitCode: 0,
      durationMs: 42,
      output: "ok",
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-relayed-failed",
          command: 'node -e "process.exit(7)"',
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "failed",
          commandActions: [],
          aggregatedOutput: "command failed",
          exitCode: 7,
          durationMs: 9,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(2));
    const failedCommandEvent = requireRecord(
      mockCallArg(afterToolCall, 1, 0, "failed command after_tool_call event"),
      "failed command after_tool_call event",
    );
    expect(failedCommandEvent.toolName).toBe("exec");
    expect(failedCommandEvent.params).toEqual({ command: 'node -e "process.exit(7)"' });
    expect(failedCommandEvent.result).toEqual({
      status: "failed",
      exitCode: 7,
      durationMs: 9,
      output: "command failed",
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-relayed",
          status: "completed",
          changes: [{ path: "/workspace/src/example.ts", kind: "update" }],
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(3));
    const fileChangeEvent = requireRecord(
      mockCallArg(afterToolCall, 2, 0, "file change after_tool_call event"),
      "file change after_tool_call event",
    );
    expect(fileChangeEvent.toolName).toBe("apply_patch");
    expect(fileChangeEvent.params).toEqual({ command: "*** Begin Patch\n*** End Patch" });
    expect(fileChangeEvent.result).toEqual({
      status: "completed",
      changes: [{ path: "/workspace/src/example.ts", kind: "update" }],
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "mcp-relayed",
          server: "filesystem",
          tool: "read_file",
          arguments: { path: "/workspace/package.json" },
          status: "completed",
          result: { content: [{ type: "text", text: "{}" }] },
          error: null,
          durationMs: 4,
        },
      }),
    );
    expect(afterToolCall).toHaveBeenCalledTimes(3);

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "native tool observability",
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(4));
    const event = requireRecord(
      mockCallArg(afterToolCall, 3, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({ query: "native tool observability" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("search-observed");
    expect(event.result).toEqual({
      status: "completed",
      durationMs: 5,
      query: "native tool observability",
    });
  });

  it("cancels deferred native observations when the run aborts", async () => {
    const afterToolCall = vi.fn();
    const abortController = new AbortController();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(await createParams(), {
      nativePostToolUseRelayEnabled: true,
      consumeNativePostToolUseContext: () => undefined,
      runAbortSignal: abortController.signal,
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-aborted",
          command: "pnpm test",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );
    abortController.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(afterToolCall).not.toHaveBeenCalled();
  });

  it("does not wait for native PostToolUse context after a failed command", async () => {
    const afterToolCall = vi.fn();
    const consumeNativePostToolUseContext = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(await createParams(), {
      nativePostToolUseRelayEnabled: true,
      consumeNativePostToolUseContext,
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-failed-without-post-tool-use",
          command: 'node -e "process.exit(7)"',
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "failed",
          commandActions: [],
          aggregatedOutput: "command failed",
          exitCode: 7,
          durationMs: 9,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    expect(consumeNativePostToolUseContext).toHaveBeenCalledOnce();
    expect(
      requireRecord(
        mockCallArg(afterToolCall, 0, 0, "failed command after_tool_call event"),
        "failed command after_tool_call event",
      ),
    ).toMatchObject({
      toolName: "exec",
      params: { command: 'node -e "process.exit(7)"', cwd: "/workspace" },
      result: {
        status: "failed",
        exitCode: 7,
        durationMs: 9,
        output: "command failed",
      },
    });
  });

  it("uses Codex web search action metadata when the top-level query is empty", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "",
          action: {
            type: "search",
            query: "native action query",
            queries: ["native action query", "secondary query"],
          },
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
    expect(event.result).toEqual({
      status: "completed",
      durationMs: 5,
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
  });

  it("marks unavailable Codex web search queries explicitly", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "",
          action: { type: "other" },
          status: "completed",
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.params).toEqual({
      action: "other",
      queryUnavailable: true,
    });
    expect(event.result).toEqual({
      status: "completed",
      action: "other",
      queryUnavailable: true,
    });
  });
});
