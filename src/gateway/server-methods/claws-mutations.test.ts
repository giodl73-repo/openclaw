import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawControlUiCommand,
  ClawControlUiWorkerResult,
} from "../../claws/control-ui-worker-contract.js";
import type { CronJob } from "../../cron/types.js";
import {
  listCoreAdvertisedGatewayMethodNames,
  resolveCoreOperatorGatewayMethodScope,
} from "../methods/core-method-policy.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { prepareGatewayRequestHandler } from "./lazy-core-handlers.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

const worker = vi.hoisted(() =>
  vi.fn<typeof import("../../claws/control-ui-worker.js").runClawControlUiOperation>(),
);
vi.mock("../../claws/control-ui-worker.js", () => ({ runClawControlUiOperation: worker }));

const cases = [
  {
    method: "claws.add.apply",
    command: {
      operation: "add",
      params: {
        source: { packageName: "test-claw", version: "1.0.0" },
        agentId: "analyst",
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeClawHubRisk: true,
      },
    },
    scope: "operator.admin",
  },
  {
    method: "claws.update.apply",
    command: {
      operation: "update",
      params: {
        target: "analyst",
        source: { packageName: "test-claw", version: "1.1.0" },
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeClawHubRisk: true,
      },
    },
    scope: "operator.admin",
  },
  {
    method: "claws.remove.plan",
    command: { operation: "remove.plan", params: { target: "analyst", removeUnused: true } },
    scope: "operator.read",
  },
  {
    method: "claws.remove.apply",
    command: {
      operation: "remove",
      params: { target: "analyst", removeUnused: true, planIntegrity: "sha256:reviewed-plan" },
    },
    scope: "operator.admin",
  },
] satisfies Array<{ method: string; command: ClawControlUiCommand; scope: string }>;

function resultFor(command: ClawControlUiCommand): ClawControlUiWorkerResult {
  if (command.operation === "remove.plan") {
    return {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "remove",
      planIntegrity: "sha256:reviewed-plan",
      target: { agentId: "analyst" },
      actions: [],
      capabilities: [],
      blockers: [],
      riskAcknowledgementRequired: false,
    };
  }
  return {
    schemaVersion: "openclaw.clawsGatewayApply.v1",
    operation: command.operation,
    status: "complete",
    agentId: "analyst",
    message: "Claw operation completed.",
  };
}

function browserClient(scopes = ["operator.admin"]): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes,
    },
    connId: "claws-browser",
    authenticatedUserId: "profile-claws-browser",
    internal: { authenticatedOperator: true, authenticatedControlUi: true, controlUiAdmin: true },
  };
}

function request(method: string, params: Record<string, unknown>, client = browserClient()) {
  return {
    req: { type: "req" as const, id: "claws-mutation-boundary", method, params },
    params,
    respond: vi.fn<RespondFn>(),
    client,
    context: {
      getRuntimeConfig: vi.fn(() => ({ agents: { entries: {} } })),
    } as unknown as GatewayRequestContext,
    isWebchatConnect: vi.fn(() => true),
    hasCurrentClientAuthority: vi.fn(() => true),
    sessionMutationCommitGuard: vi.fn<() => void>(),
    signal: new AbortController().signal,
  } satisfies GatewayRequestHandlerOptions;
}

async function dispatch(options: GatewayRequestHandlerOptions) {
  const forwarding = expectDefined(
    coreGatewayHandlers[options.req.method],
    "registered Claw handler",
  );
  const handler = await prepareGatewayRequestHandler(forwarding);
  expect(handler).not.toBe(forwarding);
  await handler(options);
}

function expectRefused(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
  worker.mockReset();
  worker.mockImplementation(async (command, options) => {
    options.assertCurrent();
    return resultFor(command);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Boundary proof only: real lazy registration, schemas, adapter and cron handler;
// worker transport/lifecycle and cron persistence are not exercised by this suite.
describe("Claw mutations: registered Gateway boundary with a mocked worker", () => {
  it.each(cases)(
    "prepares $method and dispatches its validated command",
    async ({ method, command, scope }) => {
      const options = request(method, command.params);
      await dispatch(options);

      expect(resolveCoreOperatorGatewayMethodScope(method)).toBe(scope);
      expect(worker).toHaveBeenCalledExactlyOnceWith(command, {
        assertCurrent: expect.any(Function),
        request: expect.any(Function),
      });
      expect(options.sessionMutationCommitGuard).toHaveBeenCalled();
      expect(options.respond).toHaveBeenCalledExactlyOnceWith(true, resultFor(command));
    },
  );

  it.each(cases)(
    "rejects missing and additional $method parameters before worker admission",
    async ({ method, command }) => {
      for (const params of [{}, { ...command.params, shellCommand: "unexpected" }]) {
        const options = request(method, params);
        await dispatch(options);
        expectRefused(options.respond);
      }
      expect(worker).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("rejects $method while the feature is disabled", async ({ method, command }) => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const options = request(method, command.params);
    await dispatch(options);
    expectRefused(options.respond);
    expect(worker).not.toHaveBeenCalled();
  });

  it("advertises mutation methods only while the feature is enabled", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    for (const { method } of cases) {
      expect(listCoreAdvertisedGatewayMethodNames()).not.toContain(method);
    }
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    for (const { method } of cases) {
      expect(listCoreAdvertisedGatewayMethodNames()).toContain(method);
    }
  });

  it.each(cases.filter(({ scope }) => scope === "operator.admin"))(
    "requires admin authority for $method even on an attested Control UI connection",
    async ({ method, command }) => {
      for (const scopes of [[], ["operator.read"], ["operator.write"]]) {
        const options = request(method, command.params, browserClient(scopes));
        await dispatch(options);
        expectRefused(options.respond);
      }
      expect(worker).not.toHaveBeenCalled();
    },
  );

  it("allows a read-scoped operator to preview removal", async () => {
    const command: ClawControlUiCommand = {
      operation: "remove.plan",
      params: { target: "analyst" },
    };
    const options = request("claws.remove.plan", command.params, browserClient(["operator.read"]));
    await dispatch(options);
    expect(worker).toHaveBeenCalledOnce();
    expect(options.respond).toHaveBeenCalledExactlyOnceWith(true, resultFor(command));
  });

  it("rejects a node role even with an admin scope", async () => {
    const options = request("claws.remove.apply", { target: "analyst", planIntegrity: "reviewed" });
    options.client.connect.role = "node";
    await dispatch(options);
    expectRefused(options.respond);
    expect(worker).not.toHaveBeenCalled();
  });

  it.each(["client", "callback", "scope", "commit guard", "signal", "feature flag"])(
    "revokes worker effect admission and host callbacks after %s revocation",
    async (reason) => {
      const options = request("claws.remove.apply", {
        target: "analyst",
        planIntegrity: "reviewed",
      });
      const controller = new AbortController();
      options.signal = controller.signal;
      const effect = vi.fn();
      let guardFailure: unknown;
      let hostFailure: unknown;
      worker.mockImplementationOnce(async (command, authority) => {
        authority.assertCurrent();
        await Promise.resolve();
        switch (reason) {
          case "client":
            options.client.invalidated = true;
            break;
          case "callback":
            options.hasCurrentClientAuthority.mockReturnValue(false);
            break;
          case "scope":
            options.client.connect.scopes = ["operator.read"];
            break;
          case "commit guard":
            options.sessionMutationCommitGuard.mockImplementation(() => {
              throw new Error("revoked");
            });
            break;
          case "signal":
            controller.abort();
            break;
          case "feature flag":
            vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
            break;
        }
        try {
          authority.assertCurrent();
        } catch (error) {
          guardFailure = error;
        }
        try {
          await authority.request({ method: "config", params: {} });
        } catch (error) {
          hostFailure = error;
        }
        if (guardFailure || hostFailure) {
          throw guardFailure ?? hostFailure;
        }
        effect();
        return resultFor(command);
      });

      await dispatch(options);
      expect(worker).toHaveBeenCalledOnce();
      expect(guardFailure).toBeInstanceOf(Error);
      expect(hostFailure).toBeInstanceOf(Error);
      expect(options.context.getRuntimeConfig).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      expectRefused(options.respond);
    },
  );

  it.each([false, true])(
    "forwards browser authority through the real cron commit guard (revoked: %s)",
    async (revoke) => {
      const { cronHandlers } = await import("./cron.js");
      const owner = vi.spyOn(cronHandlers, "cron.remove");
      const options = request("claws.remove.apply", {
        target: "analyst",
        planIntegrity: "reviewed",
      });
      const committed = vi.fn();
      const job: CronJob = {
        id: "claw-cron",
        name: "Claw scheduled task",
        agentId: "analyst",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review" },
        state: {},
      };
      const remove = vi.fn<GatewayRequestContext["cron"]["remove"]>(async (_id, mutation) => {
        const commitGuard = expectDefined(mutation?.commitGuard, "browser cron commit guard");
        commitGuard();
        await Promise.resolve();
        if (revoke) {
          options.client.invalidated = true;
        }
        commitGuard();
        committed();
        return { ok: true, removed: true };
      });
      options.context = {
        ...options.context,
        cron: {
          readJob: vi.fn(async () => job),
          getDefaultAgentId: () => "main",
          remove,
        } as unknown as GatewayRequestContext["cron"],
        logGateway: { info: vi.fn() } as unknown as GatewayRequestContext["logGateway"],
      };
      worker.mockImplementationOnce(async (command, authority) => {
        await authority.request({ method: "cron.remove", params: { id: job.id } });
        return resultFor(command);
      });

      await dispatch(options);
      expect(owner).toHaveBeenCalledOnce();
      const forwarded = expectDefined(owner.mock.calls[0]?.[0], "forwarded cron request");
      expect(forwarded.client).toBe(options.client);
      expect(forwarded.context).toBe(options.context);
      expect(forwarded.signal).toBe(options.signal);
      expect(forwarded.hasCurrentClientAuthority).toBe(options.hasCurrentClientAuthority);
      expect(forwarded.isWebchatConnect).toBe(options.isWebchatConnect);
      expect(forwarded.req).toMatchObject({
        id: options.req.id,
        method: "cron.remove",
        params: { id: job.id },
      });
      expect(forwarded.sessionMutationCommitGuard).not.toBe(options.sessionMutationCommitGuard);
      expect(options.sessionMutationCommitGuard).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledExactlyOnceWith(job.id, { commitGuard: expect.any(Function) });
      if (revoke) {
        expect(committed).not.toHaveBeenCalled();
        expectRefused(options.respond);
      } else {
        expect(committed).toHaveBeenCalledOnce();
        expect(options.respond.mock.calls[0]?.[0]).toBe(true);
      }
    },
  );
});
