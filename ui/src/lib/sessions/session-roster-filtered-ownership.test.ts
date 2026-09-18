import type {
  ControlModelCatalog,
  ControlModelSessionCatalogSnapshot,
} from "@openclaw/gateway-client/model";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";

function idleCatalog(): ControlModelSessionCatalogSnapshot {
  return {
    status: "idle",
    query: {},
    ts: null,
    path: null,
    count: 0,
    sessions: [],
    totalCount: 0,
    limitApplied: null,
    offset: null,
    nextOffset: null,
    hasMore: false,
    creators: [],
    defaults: null,
    refreshedAt: null,
    error: null,
  };
}

/**
 * The Gateway-owned catalog cannot express these membership filters, so the raw
 * `sessions.list` path stays authoritative for the read, for event-driven
 * refreshes, and against catalog pushes carrying another query.
 */
describe("Gateway-filtered primary rosters", () => {
  it.each([
    { filter: "involving-me", query: { involvingMe: true } },
    { filter: "board", query: { hasBoard: true } },
    { filter: "owner-first", query: { ownerFirst: true } },
  ])(
    "keeps a $filter-filtered roster authoritative once the catalog is loaded",
    async ({ query }) => {
      let modelListener: (() => void) | undefined;
      let eventListener:
        | ((event: { type: "event"; event: string; payload?: unknown }) => void)
        | undefined;
      let catalog = idleCatalog();
      const refreshSessions = vi.fn(async (_options: unknown, next?: Record<string, unknown>) => {
        catalog = {
          ...catalog,
          status: "ready",
          query: next ?? {},
          ts: 1,
          path: "sessions.list",
          count: 1,
          sessions: [{ key: "agent:main:catalog", kind: "direct" }],
          totalCount: 1,
          refreshedAt: 1,
          defaults: { modelProvider: "test", model: "test", contextTokens: 1 },
        };
      });
      const model = {
        getSnapshot: () => ({
          revision: 1,
          lifecycle: "running",
          connection: { status: "connected", epoch: 1 },
          sessionCatalog: catalog,
        }),
        subscribe(listener: () => void) {
          modelListener = listener;
          return () => undefined;
        },
        start: vi.fn(),
        refreshSessions,
        conversation: vi.fn(),
        releaseConversation: vi.fn(async () => undefined),
        dispose: vi.fn(),
      } as unknown as ControlModelCatalog;
      const request = vi.fn(async () =>
        sessionsResult([{ key: "agent:main:filtered", kind: "direct", updatedAt: 1 }], 1),
      );
      const sessions = createTestSessionCapability({
        snapshot: {
          client: { request } as unknown as GatewayBrowserClient,
          phase: "connected",
          sessionKey: "agent:main:main",
          assistantAgentId: "main",
          hello: null,
        },
        controlModel: model,
        loadControlModelCatalog: async () => model,
        subscribe: () => () => undefined,
        subscribeEvents(listener) {
          eventListener = listener;
          return () => undefined;
        },
      });

      try {
        // The unfiltered roster adopts the catalog, which loads its adapter.
        await sessions.refresh({ agentId: "main", force: true });
        expect(refreshSessions).toHaveBeenCalledOnce();
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
          "agent:main:catalog",
        ]);

        await sessions.refresh({ agentId: "main", ...query, force: true });
        expect(refreshSessions).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "sessions.list",
          expect.objectContaining({ agentId: "main", ...query }),
        );
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
          "agent:main:filtered",
        ]);

        // A catalog push for its own unrelated query must not replace the roster.
        modelListener?.();
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
          "agent:main:filtered",
        ]);

        // The catalog does not refresh this roster, so the event still owes it
        // an authoritative Gateway read.
        eventListener?.({
          type: "event",
          event: "sessions.changed",
          payload: { agentId: "main", reason: "update", sessionKey: "agent:main:filtered" },
        });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request).toHaveBeenLastCalledWith(
          "sessions.list",
          expect.objectContaining({ agentId: "main", ...query }),
        );
        expect(refreshSessions).toHaveBeenCalledOnce();
      } finally {
        sessions.dispose();
      }
    },
  );
});
