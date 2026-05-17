import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerEventProjector } from "./extensions/codex/src/app-server/event-projector.ts";
import { buildEmbeddedRunPayloads } from "./src/agents/pi-embedded-runner/run/payloads.ts";

const threadId = "thread-proof-83108";
const turnId = "turn-proof-83108";
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr83108-workspace-"));
const sessionFile = path.join(workspaceDir, "session.jsonl");
await fs.writeFile(sessionFile, "", "utf8");

const model = {
  id: "gpt-5.4-codex",
  name: "gpt-5.4-codex",
  provider: "openai-codex",
  api: "openai-codex-responses",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8000,
};

const params = {
  prompt: "Run PR review skill",
  sessionId: "session-proof-83108",
  sessionFile,
  workspaceDir,
  runId: "run-proof-83108",
  provider: "openai-codex",
  modelId: "gpt-5.4-codex",
  model,
  thinkLevel: "medium",
  agentId: "main",
  sessionKey: "agent:main:session-proof-83108",
};

function notification(method: string, extra: Record<string, unknown>) {
  return { method, params: { threadId, turnId, ...extra } } as never;
}

const declinedCommandItem = {
  type: "commandExecution",
  id: "cmd-declined-native-bash",
  command: "pnpm test extensions/codex",
  cwd: "/workspace/openclaw",
  processId: null,
  source: "agent",
  status: "declined",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: 1,
};

const projector = new CodexAppServerEventProjector(params as never, threadId, turnId);
await projector.handleNotification(notification("item/started", {
  item: { ...declinedCommandItem, status: "inProgress", durationMs: null },
}));
await projector.handleNotification(notification("item/completed", { item: declinedCommandItem }));
await projector.handleNotification(notification("turn/completed", {
  turn: { id: turnId, status: "interrupted", items: [declinedCommandItem] },
}));

const attempt = projector.buildResult({
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
});

const payloads = buildEmbeddedRunPayloads({
  assistantTexts: attempt.assistantTexts ?? [],
  toolMetas: attempt.toolMetas ?? [],
  lastAssistant: attempt.lastAssistant,
  currentAssistant: attempt.lastAssistant,
  lastToolError: attempt.lastToolError,
  isCronTrigger: false,
  sessionKey: "agent:main:session-proof-83108",
  provider: "openai-codex",
  model: "gpt-5.4-codex",
  verboseLevel: "off",
  reasoningLevel: "off",
  toolResultFormat: "plain",
  inlineToolResultsAllowed: false,
  didSendViaMessagingTool: false,
  runAborted: attempt.aborted,
  agentId: "main",
  runId: "run-proof-83108",
});

const proof = {
  commit: process.env.PROOF_COMMIT,
  label: process.env.PROOF_LABEL,
  scenario: "Real production path: CodexAppServerEventProjector handles item/commandExecution declined native bash event, then buildEmbeddedRunPayloads prepares the external-channel reply payload for an interrupted empty turn.",
  inputEvent: {
    methodSequence: ["item/started", "item/completed", "turn/completed"],
    completedItem: declinedCommandItem,
  },
  projectedAttempt: {
    aborted: attempt.aborted,
    assistantTexts: attempt.assistantTexts ?? [],
    toolMetas: attempt.toolMetas ?? [],
    lastToolError: attempt.lastToolError ?? null,
  },
  externalChannelPayloads: payloads.map((payload) => ({
    text: payload.text ?? null,
    isError: payload.isError ?? false,
    mediaUrl: payload.mediaUrl ?? null,
    mediaUrls: payload.mediaUrls ?? null,
  })),
};
console.log(JSON.stringify(proof, null, 2));
