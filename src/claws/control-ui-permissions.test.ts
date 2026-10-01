import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as memorySearch from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { buildClawPermissionDisclosure } from "./control-ui-permissions.js";
import {
  isClawToolPolicyConsentResolutionError,
  prepareCapturedClawToolPolicyConsent,
} from "./tool-policy-runtime.js";

const desiredAgent = { id: "assistant", workspace: "/private/workspace" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claw configured permission disclosure", () => {
  it("marks the preserved implicit main collision unresolved without replacing its permissions", () => {
    const result = buildClawPermissionDisclosure({
      config: {},
      operation: "add",
      agentId: "main",
      desiredAgent: { ...desiredAgent, id: "main", tools: { deny: ["exec"] } },
    });
    expect(result.desired).toBeUndefined();
    expect(result.unresolved).toContain("target-agent");
  });

  it("keeps the desired preview when the consent owner cannot verify current permissions", () => {
    const config: OpenClawConfig = {
      agents: { entries: { assistant: { tools: { profile: "full", allow: ["read"] } } } },
    };
    // Only read absent cached provenance; this does not open or create a database.
    prepareCapturedClawToolPolicyConsent(config, {
      path: resolve("fixture-unprepared-claw-consent.sqlite"),
    });
    const result = buildClawPermissionDisclosure({
      config,
      operation: "update",
      agentId: "assistant",
      desiredAgent,
    });
    expect(result.current).toBeUndefined();
    expect(result.desired?.tools.allowed).toContain("read");
    expect(result.unresolved).toContain("current-agent");
    expect(JSON.stringify(result)).not.toMatch(/provenance|sqlite|fixture/u);
    const spoofed = new Error("Unrelated failure");
    spoofed.name = "ClawToolProfileConsentStateError";
    expect(isClawToolPolicyConsentResolutionError(spoofed)).toBe(false);
  });

  it("shows inherited defaults without treating an empty profile as no permissions", () => {
    const result = buildClawPermissionDisclosure({
      config: {},
      operation: "add",
      agentId: "assistant",
      desiredAgent,
    });
    expect(result.current).toBeUndefined();
    expect(result.desired?.tools.allowed).toContain("exec");
    expect(result.desired?.sandbox).toMatchObject({ mode: "off", workspaceAccess: "none" });
    expect(result.desired?.filesystem.workspaceOnly).toBe(false);
    expect(result.desired?.heartbeat.enabled).toBe(false);
    expect(result.desired?.memorySearch).toEqual({
      state: "configured",
      rememberAcrossConversations: true,
      sessionMemory: true,
      indexedSources: ["memory", "sessions"],
      searchSources: ["memory"],
      extraPathCount: 0,
    });
    expect(result.desired?.subagentTargets).toEqual({
      explicitAgentIds: ["assistant"],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: true,
      requireAgentId: false,
    });
    expect(result.unresolved).toEqual([
      "runtime-tools",
      "sandbox-runtime",
      "memory",
      "delegation",
      "scheduled-jobs",
    ]);
  });

  it("uses memory overrides and counts deduplicated roots without disclosing paths", () => {
    const result = buildClawPermissionDisclosure({
      operation: "update",
      agentId: "assistant",
      config: {
        agents: { entries: { assistant: {} } },
        memory: {
          search: {
            rememberAcrossConversations: true,
            sources: [],
            extraPaths: [
              "/private/shared",
              " /private/shared ",
              { path: "/private/shared", pattern: "*.md" },
            ],
          },
        },
      },
      desiredAgent: {
        ...desiredAgent,
        memory: {
          search: {
            rememberAcrossConversations: false,
            experimental: { sessionMemory: true },
            sources: ["sessions"],
            extraPaths: [
              "/private/shared",
              { path: "/private/shared", pattern: " *.md " },
              "/private/agent",
            ],
          },
        },
      },
    });
    expect(result.current?.memorySearch).toEqual({
      state: "configured",
      rememberAcrossConversations: true,
      sessionMemory: true,
      indexedSources: ["memory", "sessions"],
      searchSources: ["memory"],
      extraPathCount: 2,
    });
    expect(result.desired?.memorySearch).toEqual({
      state: "configured",
      rememberAcrossConversations: false,
      sessionMemory: true,
      indexedSources: ["sessions"],
      searchSources: ["sessions"],
      extraPathCount: 3,
    });
    expect(result.unresolved).toEqual(expect.arrayContaining(["memory", "delegation"]));
    expect(JSON.stringify(result)).not.toMatch(/private|\.md|extraPaths/u);
  });

  it.each(["defaults", "agent"] as const)("reports memory disabled by %s", (owner) => {
    const result = buildClawPermissionDisclosure({
      operation: "add",
      agentId: "assistant",
      config: { memory: { search: { enabled: owner !== "defaults" } } },
      desiredAgent: {
        ...desiredAgent,
        ...(owner === "agent" ? { memory: { search: { enabled: false } } } : {}),
      },
    });
    expect(result.desired?.memorySearch).toEqual({ state: "disabled" });
  });

  it("inherits isolated-DM recall policy and filters unenabled session sources", () => {
    const result = buildClawPermissionDisclosure({
      operation: "add",
      agentId: "assistant",
      config: {
        session: { dmScope: "per-peer" },
        memory: { search: { sources: ["sessions"] } },
      },
      desiredAgent,
    });
    expect(result.desired?.memorySearch).toEqual({
      state: "configured",
      rememberAcrossConversations: false,
      sessionMemory: false,
      indexedSources: ["memory"],
      searchSources: ["memory"],
      extraPathCount: 0,
    });
  });

  it("isolates a real unavailable memory owner and cleans up its degraded state", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("assistant"),
        state: "unavailable",
        paths: ["private-memory-path"],
        refKeys: ["private-secret-ref"],
        reason: "private-provider-failure",
      },
    ]);
    try {
      const result = buildClawPermissionDisclosure({
        operation: "update",
        agentId: "assistant",
        config: { agents: { entries: { assistant: {} } } },
        desiredAgent: { ...desiredAgent, memory: { search: { enabled: false } } },
      });
      expect(result.current?.memorySearch).toEqual({ state: "unresolved" });
      expect(result.current?.tools.allowed).toContain("read");
      expect(result.desired?.memorySearch).toEqual({ state: "disabled" });
      expect(result.unresolved).toContain("memory");
      expect(JSON.stringify(result)).not.toMatch(/private|SecretSurface|memory-provider/u);
    } finally {
      setActiveDegradedSecretOwners([]);
    }
    expect(
      buildClawPermissionDisclosure({
        config: {},
        operation: "add",
        agentId: "assistant",
        desiredAgent,
      }).desired?.memorySearch.state,
    ).toBe("configured");
  });

  it("does not hide forged or unrelated owner errors from memory resolution", () => {
    const spoofed = new Error("unrelated failure");
    spoofed.name = "SecretSurfaceUnavailableError";
    const otherOwner = new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId("other"),
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "unavailable",
    });
    for (const error of [spoofed, otherOwner]) {
      vi.spyOn(memorySearch, "resolveMemorySearchIndexConfig").mockImplementationOnce(() => {
        throw error;
      });
      expect(() =>
        buildClawPermissionDisclosure({
          config: {},
          operation: "add",
          agentId: "assistant",
          desiredAgent,
        }),
      ).toThrow(error);
    }
  });

  it.each([
    { allowAgents: [], requireAgentId: false, ids: [], wildcard: false, implicit: true },
    {
      allowAgents: ["missing", "other", "other"],
      requireAgentId: false,
      ids: ["other"],
      wildcard: false,
      implicit: true,
    },
    {
      allowAgents: ["*"],
      requireAgentId: false,
      ids: ["assistant", "other"],
      wildcard: true,
      implicit: true,
    },
    { allowAgents: [], requireAgentId: true, ids: [], wildcard: false, implicit: false },
    {
      allowAgents: ["assistant"],
      requireAgentId: true,
      ids: ["assistant"],
      wildcard: false,
      implicit: false,
    },
  ])(
    "projects inherited delegation targets $allowAgents with requireAgentId=$requireAgentId",
    ({ allowAgents, requireAgentId, ids, wildcard, implicit }) => {
      const result = buildClawPermissionDisclosure({
        operation: "update",
        agentId: "assistant",
        config: {
          agents: {
            entries: { assistant: {}, other: {} },
            defaults: { subagents: { allowAgents, requireAgentId } },
          },
        },
        desiredAgent,
      });
      expect(result.current?.subagentTargets).toEqual({
        explicitAgentIds: ids,
        allowAnyConfiguredAgent: wildcard,
        implicitSelfAllowed: implicit,
        requireAgentId,
      });
      expect(result.desired?.subagentTargets).toEqual(result.current?.subagentTargets);
      expect(result.unresolved).toContain("delegation");
    },
  );

  it("uses agent delegation overrides, including an explicit false requireAgentId", () => {
    const result = buildClawPermissionDisclosure({
      operation: "update",
      agentId: "assistant",
      config: {
        agents: {
          entries: { assistant: {}, other: {} },
          defaults: { subagents: { allowAgents: ["*"], requireAgentId: true } },
        },
      },
      desiredAgent: { ...desiredAgent, subagents: { allowAgents: [], requireAgentId: false } },
    });
    expect(result.current?.subagentTargets.allowAnyConfiguredAgent).toBe(true);
    expect(result.desired?.subagentTargets).toEqual({
      explicitAgentIds: [],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: true,
      requireAgentId: false,
    });
  });

  it("uses global deny policy even when the desired agent explicitly allows a tool", () => {
    const result = buildClawPermissionDisclosure({
      config: { tools: { deny: ["exec"] } },
      operation: "add",
      agentId: "assistant",
      desiredAgent: { ...desiredAgent, tools: { profile: "full", allow: ["exec", "read"] } },
    });
    expect(result.desired?.tools.allowed).toContain("read");
    expect(result.desired?.tools.allowed).not.toContain("exec");
    expect(result.desired?.tools.excluded).toContain("exec");
  });

  it("includes primary-model provider restrictions from the runtime policy owner", () => {
    const result = buildClawPermissionDisclosure({
      config: { tools: { byProvider: { openai: { deny: ["exec"] } } } },
      operation: "add",
      agentId: "assistant",
      desiredAgent: { ...desiredAgent, model: { primary: "openai/gpt-4.1" } },
    });
    expect(result.desired?.tools.excluded).toContain("exec");
  });

  it("compares full current and desired facts even when permissions are unchanged", () => {
    const config: OpenClawConfig = {
      agents: { entries: { assistant: { workspace: desiredAgent.workspace } } },
      tools: { profile: "minimal", fs: { workspaceOnly: true } },
    };
    const original = structuredClone(config);
    const result = buildClawPermissionDisclosure({
      config,
      operation: "update",
      agentId: "assistant",
      desiredAgent,
    });
    expect(result.current).toEqual(result.desired);
    expect(result.current?.filesystem.workspaceOnly).toBe(true);
    expect(config).toEqual(original);
  });

  it("shows reductions and expansions without serializing private resolver fields", () => {
    const result = buildClawPermissionDisclosure({
      operation: "update",
      agentId: "assistant",
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "session",
              workspaceAccess: "ro",
              docker: { env: { PRIVATE: "fixture-secret" }, binds: ["/private/data:/data"] },
            },
          },
          entries: {
            assistant: {
              workspace: "/private/workspace",
              tools: { deny: ["exec"] },
              heartbeat: { every: "10m", prompt: "fixture-secret", target: "none" },
            },
          },
        },
      },
      desiredAgent: {
        ...desiredAgent,
        sandbox: { mode: "off" },
        tools: { fs: { workspaceOnly: true } },
        heartbeat: { every: "0m" },
      },
    });
    expect(result.current?.tools.excluded).toContain("exec");
    expect(result.desired?.tools.allowed).toContain("exec");
    expect(result.current?.sandbox.mode).toBe("all");
    expect(result.desired?.sandbox.mode).toBe("off");
    expect(result.current?.heartbeat).toEqual({ enabled: true, intervalMs: 600_000 });
    expect(result.desired?.heartbeat).toEqual({ enabled: false, intervalMs: null });
    expect(JSON.stringify(result)).not.toMatch(/private|fixture|prompt|binds|env/u);
  });

  it("does not invent a desired agent for an unresolved target or an add collision", () => {
    for (const params of [
      { operation: "update" as const, config: {} },
      {
        operation: "add" as const,
        config: { agents: { entries: { assistant: {} } } },
        desiredAgent,
      },
    ]) {
      const result = buildClawPermissionDisclosure({ ...params, agentId: "assistant" });
      expect(result.desired).toBeUndefined();
      expect(result.unresolved).toContain("target-agent");
    }
  });
});
