import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../../plugin-state/plugin-state-store.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { disposePluginRegistryInstances, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { getToolResult, runMessageAction } from "./message-action-runner.js";
import { resetDirectoryCache } from "./target-resolver.js";

const graphFetch = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
);

const conversation = "conversation:19:discovered-current@thread.tacv2";
const graphConversation = "19:discovered-current@thread.tacv2";
const context: ChannelThreadingToolContext = {
  currentChannelProvider: "msteams",
  currentChannelId: conversation,
  currentChatType: "group",
  currentMessageId: 1751234567890,
};
const cfg: OpenClawConfig = {
  channels: {
    msteams: {
      groupPolicy: "open",
      dmPolicy: "open",
      appId: "discovery-proof-app",
      appPassword: "discovery-proof-secret",
      tenantId: "discovery-proof-tenant",
      delegatedAuth: { enabled: true },
    },
  },
  plugins: {
    enabled: true,
    allow: ["msteams"],
    entries: { msteams: { enabled: true } },
  },
};

describe("discovered Teams message-action routing", () => {
  let registry: PluginRegistry | undefined;
  let stateDir: string | undefined;
  let restoreEnv: ReturnType<typeof captureEnv> | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-discovery-proof-"));
    restoreEnv = captureEnv(["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_HOME", stateDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    await createPluginStateKeyedStore("msteams", {
      namespace: "delegated-token",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    }).register("current", {
      accessToken: "discovery-proof-token",
      refreshToken: "discovery-proof-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["Chat.ReadWrite"],
    });
    vi.stubGlobal("fetch", graphFetch);
  });

  afterEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetDirectoryCache();
    if (registry) {
      await disposePluginRegistryInstances(registry);
      registry = undefined;
    }
    resetPluginStateStoreForTests();
    vi.unstubAllGlobals();
    restoreEnv?.restore();
    restoreEnv = undefined;
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("discovers the bundled Teams entrypoint and routes an inbound reaction", async () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    registry = loadOpenClawPlugins({
      cache: false,
      activate: false,
      runtimeSideEffects: true,
      throwOnLoadError: true,
      preferBuiltPluginArtifacts: false,
      pluginSdkResolution: "src",
      onlyPluginIds: ["msteams"],
      config: cfg,
      env: {
        ...process.env,
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: "msteams", origin: "bundled", status: "loaded" }),
    ]);
    expect(registry.channels).toEqual([
      expect.objectContaining({ plugin: expect.objectContaining({ id: "msteams" }) }),
    ]);
    setActivePluginRegistry(registry);

    const result = await runMessageAction({
      cfg,
      action: "react",
      params: { channel: "teams", emoji: "like" },
      toolContext: context,
      requesterAccountId: "default",
    });
    expect(result).toMatchObject({ kind: "action", handledBy: "plugin", dryRun: false });
    expect(getToolResult(result)).not.toMatchObject({ isError: true });
    expect(graphFetch).toHaveBeenCalledOnce();
    const [url, init] = graphFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://graph.microsoft.com/beta/chats/${encodeURIComponent(graphConversation)}/messages/${context.currentMessageId}/setReaction`,
    );
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reactionType: "\u{1f44d}" }),
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer discovery-proof-token");
  });
});
