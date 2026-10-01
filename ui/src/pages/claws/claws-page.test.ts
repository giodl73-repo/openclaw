/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { isPluginsHubRoute } from "../../app-navigation.ts";
import { pathForRoute, routeIdFromPath, dynamicRouteFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { ClawsPage } from "./claws-page.ts";
import {
  blockedClawPermissionPlan,
  clawDetail,
  clawDoctor,
  clawMethods,
  clawPlan,
  clawRecord,
  clawStatus,
} from "./claws.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mount(
  options: {
    methods?: string[];
    scopes?: string[];
    handler?: (method: string, params: unknown) => unknown;
  } = {},
) {
  const request = vi.fn(async (method: string, params: unknown) => {
    const result = options.handler?.(method, params);
    if (result !== undefined) {
      return result;
    }
    if (method === "claws.status") {
      return clawStatus();
    }
    if (method === "claws.doctor") {
      return clawDoctor;
    }
    if (method === "claws.catalog.detail") {
      return { schemaVersion: "openclaw.clawsCatalogDetail.v1", detail: clawDetail };
    }
    if (method.endsWith(".plan")) {
      return clawPlan(
        method.includes("update") ? "update" : method.includes("remove") ? "remove" : "add",
      );
    }
    if (method.endsWith(".apply")) {
      return {
        schemaVersion: "openclaw.clawsGatewayApply.v1",
        operation: method.split(".")[1],
        status: "complete",
        agentId: "travel",
        message: "Completed",
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const harness = createApplicationGateway();
  harness.publish({
    ...harness.gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(options.methods ?? clawMethods, options.scopes),
  });
  const navigate = vi.fn();
  const roster: AgentsListResult = {
    agents: [{ id: "travel", name: "Travel Concierge" }],
    defaultId: "main",
    mainKey: "main",
  };
  const refreshAgents = vi.fn(async (): Promise<AgentsListResult | null> => roster);
  const context = {
    gateway: harness.gateway,
    navigate,
    agents: {
      refreshList: refreshAgents,
      state: { client, connected: true, agentsList: roster },
    },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-claws-page") as ClawsPage;
  provider.append(page);
  document.body.append(provider);
  await settleLitElement(page);
  const click = async (label: string) => {
    const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
    );
    expect(button, `Missing button ${label}`).toBeDefined();
    button!.click();
    await settleLitElement(page);
  };
  const input = async (name: string, value: string) => {
    const element = page.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLitElement(page);
  };
  return { page, request, harness, client, navigate, click, input, refreshAgents };
}

describe("Claws Plugins tab", () => {
  it("routes independently of plugin catalog IDs and highlights Plugins", () => {
    expect(pathForRoute("claws", "/gateway")).toBe("/gateway/claws");
    expect(routeIdFromPath("/gateway/claws", "/gateway")).toBe("claws");
    expect(dynamicRouteFromPath("/gateway/claws", "/gateway")).toBeNull();
    expect(isPluginsHubRoute("claws")).toBe(true);
  });
  it("does not read or expose the tab while the experiment is off", async () => {
    const { page, request } = await mount({ methods: [] });
    expect(request).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Claws is not enabled");
    expect(page.querySelector("#plugins-tab-claws")).toBeNull();
    expect(page.querySelector<HTMLButtonElement>("#plugins-tab-plugins")?.tabIndex).toBe(0);
    expect(page.querySelector("[role=tab][aria-selected=true]")).toBeNull();
  });
  it("previews an exact release before installation then opens native agent chat", async () => {
    const { click, input, request, navigate, page } = await mount();
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await input("agentId", "travel");
    await click("Review changes");
    expect(request).toHaveBeenCalledWith("claws.add.plan", {
      source: { packageName: clawRecord.name, version: "0.2.0" },
      agentId: "travel",
    });
    expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
    await click("Confirm changes");
    expect(request).toHaveBeenCalledWith("claws.add.apply", {
      source: { packageName: clawRecord.name, version: "0.2.0" },
      agentId: "travel",
      planIntegrity: "reviewed-exact-plan",
    });
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    await click("Continue setup in chat");
    expect(navigate).toHaveBeenCalledWith("new-session", { search: "?agent=travel" });
  });
  it("allows read-only preview but not apply", async () => {
    const { click, input, page, request } = await mount({ scopes: ["operator.read"] });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    const apply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === "Confirm changes",
    )!;
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(page.textContent).toContain("operator.admin");
    expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
  });
  it.each(["add", "update"] as const)(
    "discloses configured permissions for %s without clearing the safety blocker",
    async (operation) => {
      const { page, click, input, request } = await mount({
        scopes: ["operator.admin"],
        handler: (method) =>
          method === `claws.${operation}.plan` ? blockedClawPermissionPlan(operation) : undefined,
      });
      if (operation === "add") {
        await click("Add Claw");
        await input("packageName", clawRecord.name);
        await click("Review changes");
      } else {
        page.querySelector<HTMLButtonElement>(".claws-row")!.click();
        await settleLitElement(page);
        await click("Update");
      }
      const disclosure = page.querySelector('[aria-label="Configured permissions"]')!;
      expect(disclosure.textContent).toContain("Core-tool lists do not guarantee live tool access");
      const after = disclosure.querySelector(
        `[aria-label="${operation === "update" ? "After update" : "After installation"}"]`,
      )!;
      const facts = (element: Element) =>
        Object.fromEntries(
          [...element.querySelectorAll("dt")].map((term) => [
            term.textContent?.trim(),
            term.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim(),
          ]),
        );
      expect([...after.querySelectorAll("code")].map((node) => node.textContent)).toEqual([
        "read",
        "web_fetch",
        "exec",
        "research",
        "planner",
      ]);
      expect(facts(after)).toMatchObject({
        "Sandbox mode": "All sessions",
        "Sandbox scope": "Per agent",
        "Sandbox workspace access": "Read-only",
        "Sandbox backend": "Docker",
        "Filesystem restriction": "Workspace only",
        Heartbeat: "Enabled",
        "Heartbeat interval": "30m",
        "Memory search": "Configured",
        "Remember across conversations": "Enabled",
        "Session indexing": "Enabled",
        "Indexed sources": "Memory, Sessions",
        "Search sources": "Memory",
        "Additional path count": "2",
        "Any configured agent allowed": "No",
        "Implicit self target allowed": "No",
        "Explicit agent ID required": "Yes",
      });
      const current = disclosure.querySelector('[aria-label="Current"]');
      if (operation === "update") {
        expect(current).not.toBeNull();
        expect(facts(current!)).toMatchObject({
          "Excluded core tools": "None listed",
          "Sandbox mode": "Off",
          "Sandbox scope": "Per session",
          "Sandbox workspace access": "None",
          "Sandbox backend": "Other",
          "Filesystem restriction": "Not restricted to workspace",
          Heartbeat: "Disabled",
          "Heartbeat interval": "Not scheduled",
          "Memory search": "Disabled",
          "Explicit target agent IDs": "None listed",
          "Any configured agent allowed": "No",
          "Implicit self target allowed": "Yes",
          "Explicit agent ID required": "No",
        });
      } else {
        expect(current).toBeNull();
      }
      for (const category of [
        "Live tool availability and permissions",
        "Runtime sandbox enforcement",
        "Runtime memory availability",
        "Live delegation limits and authority",
        "Live schedules and execution permissions",
      ]) {
        expect(disclosure.textContent).toContain(category);
      }
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Applying Claws is unavailable",
      );
      const apply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Confirm changes",
      )!;
      expect(apply.disabled).toBe(true);
      apply.click();
      expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
    },
  );
  it.each(["add", "update"] as const)(
    "shows %s package schedule declarations without claiming live scheduler state",
    async (operation) => {
      const { page, click, input, request } = await mount({
        scopes: ["operator.admin"],
        handler: (method) =>
          method === `claws.${operation}.plan` ? blockedClawPermissionPlan(operation) : undefined,
      });
      if (operation === "add") {
        await click("Add Claw");
        await input("packageName", clawRecord.name);
        await click("Review changes");
      } else {
        page.querySelector<HTMLButtonElement>(".claws-row")!.click();
        await settleLitElement(page);
        await click("Update");
      }
      const schedules = page.querySelector('[aria-label="Package-declared scheduled jobs"]')!;
      expect(schedules.textContent).toContain(
        "Package declarations only, not live scheduler state.",
      );
      expect(schedules.textContent).toContain(
        "Delivery set to None does not remove message-tool authority.",
      );
      const job = schedules.querySelector('[aria-label="daily-review"]')!;
      const facts = (region: Element) =>
        [...region.querySelectorAll("dd")].map((node) => node.textContent?.trim());
      expect(facts(job.querySelector("dl")!)).toEqual([
        operation === "add" ? "Schedule" : "Change",
        "No",
      ]);
      const proposed = job.querySelector('[aria-label="Proposed declaration: daily-review"]')!;
      expect(facts(proposed)).toEqual(["0 9 * * 1-5", "America/Los_Angeles", "Isolated", "None"]);
      const recorded = job.querySelector('[aria-label="Recorded declaration: daily-review"]')!;
      if (operation === "add") {
        expect(recorded.textContent).toContain("No recorded declaration provided.");
      } else {
        expect(recorded.textContent).toContain("Recorded provenance status");
        expect(recorded.textContent).toContain("Scheduler ID recorded");
        expect(facts(recorded)).toEqual([
          "0 8 * * *",
          "UTC",
          "Agent main session",
          "Last channel",
          "Complete",
          "Yes",
        ]);
        const removed = schedules.querySelector('[aria-label="retired-review"]')!;
        expect(facts(removed.querySelector("dl")!)).toEqual(["Remove", "No"]);
        expect(
          facts(removed.querySelector('[aria-label="Recorded declaration: retired-review"]')!),
        ).toEqual(["0 12 * * 0", "UTC", "Isolated", "None", "Failed", "No"]);
        expect(removed.textContent).toContain("No proposed declaration provided.");
        const longId =
          "weekly-review-requiring-manual-reconciliation-of-package-declared-scheduler-state";
        const manual = schedules.querySelector(`[aria-label="${longId}"]`)!;
        expect(manual.querySelector("h4")?.textContent).toBe(longId);
        expect(facts(manual.querySelector("dl")!)).toEqual(["Manual review", "Yes"]);
        expect(manual.textContent).toContain("Recorded declaration could not be resolved.");
        expect(manual.textContent).toContain("No proposed declaration provided.");
        expect(manual.querySelectorAll("dd")).toHaveLength(2);
      }
      expect(schedules.textContent).not.toContain("Enabled");
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Applying Claws is unavailable",
      );
      const apply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Confirm changes",
      )!;
      expect(apply.disabled).toBe(true);
      apply.click();
      expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
    },
  );
  it.each(["empty", "omitted"] as const)(
    "distinguishes %s schedule disclosure from live schedules",
    async (state) => {
      const plan = blockedClawPermissionPlan();
      plan.scheduledJobs =
        state === "empty" ? { coverage: "package-declarations", jobs: [] } : undefined;
      const { page, click, input } = await mount({
        handler: (method) => (method === "claws.add.plan" ? plan : undefined),
      });
      await click("Add Claw");
      await input("packageName", clawRecord.name);
      await click("Review changes");
      const schedules = page.querySelector('[aria-label="Package-declared scheduled jobs"]')!;
      expect(schedules.textContent).toContain(
        state === "empty"
          ? "No package-declared jobs in this plan."
          : "Package-declared job disclosure is unavailable.",
      );
      expect(schedules.textContent).not.toContain(
        state === "empty"
          ? "Package-declared job disclosure is unavailable."
          : "No package-declared jobs in this plan.",
      );
      expect(schedules.querySelector(".claws-permission-snapshot")).toBeNull();
      expect(page.textContent).toContain("Live schedules and execution permissions");
    },
  );
  it("shows desired permissions when current agent configuration is unresolved", async () => {
    const plan = blockedClawPermissionPlan("update");
    delete plan.effectivePermissions!.current;
    plan.effectivePermissions!.unresolved.push("current-agent");
    const { page, click, request } = await mount({
      scopes: ["operator.admin"],
      handler: (method) => (method === "claws.update.plan" ? plan : undefined),
    });
    page.querySelector<HTMLButtonElement>(".claws-row")!.click();
    await settleLitElement(page);
    await click("Update");
    const disclosure = page.querySelector('[aria-label="Configured permissions"]')!;
    expect(disclosure.querySelector('[aria-label="Current"]')).toBeNull();
    expect(disclosure.querySelector('[aria-label="After update"]')?.textContent).toContain(
      "web_fetch",
    );
    expect(disclosure.textContent).toContain("Current agent configuration");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Applying Claws is unavailable",
    );
    const apply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Confirm changes",
    )!;
    expect(apply.disabled).toBe(true);
    apply.click();
    expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
  });
  it.each([
    { state: "disabled", expected: "Disabled" },
    { state: "unresolved", expected: "Not resolved" },
  ] as const)(
    "shows $state memory without inventing configuration",
    async ({ state, expected }) => {
      const plan = blockedClawPermissionPlan();
      plan.effectivePermissions!.desired!.memorySearch = { state };
      const { page, click, input } = await mount({
        handler: (method) => (method === "claws.add.plan" ? plan : undefined),
      });
      await click("Add Claw");
      await input("packageName", clawRecord.name);
      await click("Review changes");
      const memory = page.querySelector(
        '[aria-label="After installation: configured memory search"]',
      )!;
      expect(memory.querySelector("dd")?.textContent?.trim()).toBe(expected);
      expect(memory.querySelectorAll("dt")).toHaveLength(1);
      expect(memory.textContent).not.toContain("None listed");
    },
  );
  it("keeps empty configured sources and explicit target IDs distinct from unresolved data", async () => {
    const plan = blockedClawPermissionPlan();
    plan.effectivePermissions!.desired!.memorySearch = {
      state: "configured",
      rememberAcrossConversations: false,
      sessionMemory: false,
      indexedSources: [],
      searchSources: [],
      extraPathCount: 0,
    };
    plan.effectivePermissions!.desired!.subagentTargets = {
      explicitAgentIds: [],
      allowAnyConfiguredAgent: true,
      implicitSelfAllowed: true,
      requireAgentId: false,
    };
    const { page, click, input } = await mount({
      handler: (method) => (method === "claws.add.plan" ? plan : undefined),
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    const memory = page.querySelector(
      '[aria-label="After installation: configured memory search"]',
    )!;
    expect([...memory.querySelectorAll("dd")].map((node) => node.textContent?.trim())).toEqual([
      "Configured",
      "Disabled",
      "Disabled",
      "None listed",
      "None listed",
      "0",
    ]);
    const targets = page.querySelector(
      '[aria-label="After installation: subagent target policy"]',
    )!;
    expect([...targets.querySelectorAll("dd")].map((node) => node.textContent?.trim())).toEqual([
      "None listed",
      "Yes",
      "Yes",
      "No",
    ]);
  });
  it.each([
    { intervalMs: null, expected: "Not resolved" },
    { intervalMs: 0, expected: "0ms" },
  ])(
    "distinguishes enabled heartbeat interval $intervalMs from an unscheduled heartbeat",
    async ({ intervalMs, expected }) => {
      const plan = blockedClawPermissionPlan();
      plan.effectivePermissions!.desired!.heartbeat = { enabled: true, intervalMs };
      const { page, click, input } = await mount({
        handler: (method) => (method === "claws.add.plan" ? plan : undefined),
      });
      await click("Add Claw");
      await input("packageName", clawRecord.name);
      await click("Review changes");
      const snapshot = page.querySelector('[aria-label="After installation"]')!;
      const interval = [...snapshot.querySelectorAll("dt")].find(
        (term) => term.textContent?.trim() === "Heartbeat interval",
      )!;
      expect(interval.nextElementSibling?.textContent?.trim()).toBe(expected);
      expect(snapshot.textContent).not.toContain("Not scheduled");
    },
  );
  it("shows unresolved target configuration without inventing a permission snapshot", async () => {
    const { page, click, input } = await mount({
      handler: (method) =>
        method === "claws.add.plan"
          ? {
              ...blockedClawPermissionPlan(),
              effectivePermissions: {
                coverage: "configuration-only",
                unresolved: ["target-agent"],
              },
            }
          : undefined,
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    const disclosure = page.querySelector('[aria-label="Configured permissions"]')!;
    expect(disclosure.textContent).toContain("Configured permission snapshot unavailable.");
    expect(disclosure.textContent).toContain("Target agent configuration");
    expect(disclosure.querySelector(".claws-permission-snapshot")).toBeNull();
  });
  it("does not infer permissions when the optional disclosure is absent", async () => {
    const { page, click, input } = await mount({
      handler: (method) =>
        method === "claws.add.plan"
          ? {
              ...blockedClawPermissionPlan(),
              effectivePermissions: undefined,
            }
          : undefined,
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    expect(page.querySelector('[aria-label="Configured permissions"]')).toBeNull();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Applying Claws is unavailable",
    );
  });
  it.each(["update", "remove"] as const)(
    "binds %s to the selected installed agent",
    async (operation) => {
      const { click, request, page } = await mount();
      page.querySelector<HTMLButtonElement>(".claws-row")!.click();
      await settleLitElement(page);
      await click(operation === "update" ? "Update" : "Remove");
      if (operation === "remove") {
        const schedules = page.querySelector('[aria-label="Package-declared scheduled jobs"]')!;
        expect(schedules.textContent).toContain("Package-declared job disclosure is unavailable.");
        expect(schedules.textContent).not.toContain("No package-declared jobs in this plan.");
        expect(schedules.querySelector(".claws-permission-snapshot")).toBeNull();
      }
      await click("Confirm changes");
      expect(request).toHaveBeenCalledWith(
        `claws.${operation}.apply`,
        operation === "update"
          ? {
              target: "travel",
              source: { packageName: clawRecord.name, version: "0.2.0" },
              planIntegrity: "reviewed-exact-plan",
            }
          : { target: "travel", removeUnused: false, planIntegrity: "reviewed-exact-plan" },
      );
    },
  );
  it.each(["add", "update", "remove"] as const)(
    "reports an unavailable %s apply method even for an admin",
    async (operation) => {
      const { click, input, page, request } = await mount({
        scopes: ["operator.admin"],
        methods: clawMethods.filter((method) => method !== `claws.${operation}.apply`),
      });
      if (operation === "add") {
        await click("Add Claw");
        await input("packageName", clawRecord.name);
        await click("Review changes");
      } else {
        page.querySelector<HTMLButtonElement>(".claws-row")!.click();
        await settleLitElement(page);
        await click(operation === "update" ? "Update" : "Remove");
      }
      expect(page.textContent).toContain("This operation is unavailable on this Gateway.");
      expect(page.textContent).not.toContain("operator.admin");
      const apply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Confirm changes",
      )!;
      expect(apply.disabled).toBe(true);
      apply.click();
      expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
    },
  );
  it("discards a late preview after a same-client reconnect", async () => {
    const pending = createDeferred<unknown>();
    const { click, input, page, harness, client, request } = await mount({
      handler: (method) => (method === "claws.add.plan" ? pending.promise : undefined),
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    harness.publish({ ...harness.gateway.snapshot, phase: "reconnecting" });
    harness.publish({
      ...harness.gateway.snapshot,
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(clawMethods),
    });
    pending.resolve(clawPlan());
    await settleLitElement(page);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request.mock.calls.some(([method]) => method.endsWith(".apply"))).toBe(false);
  });
  it("retires consent and reconciles status after an uncertain apply without retry", async () => {
    const { click, input, page, request } = await mount({
      handler: (method) =>
        method === "claws.add.apply" ? Promise.reject(new Error("Connection lost")) : undefined,
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    await click("Confirm changes");
    expect(page.textContent).toContain("operation was not confirmed");
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(2);
  });
  it("does not fall back to the default agent when the fresh roster is unavailable", async () => {
    const { page, click, refreshAgents, navigate } = await mount();
    refreshAgents.mockResolvedValue(null);
    page.querySelector<HTMLButtonElement>(".claws-row")!.click();
    await settleLitElement(page);
    await click("Continue setup in chat");
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Agent travel is not available");
  });
  it("does not navigate when a roster refresh outlives its Gateway connection", async () => {
    const roster = createDeferred<AgentsListResult | null>();
    const { page, click, refreshAgents, navigate, harness } = await mount();
    refreshAgents.mockReturnValue(roster.promise);
    page.querySelector<HTMLButtonElement>(".claws-row")!.click();
    await settleLitElement(page);
    await click("Continue setup in chat");
    harness.publish({ ...harness.gateway.snapshot, phase: "reconnecting" });
    roster.resolve({ agents: [{ id: "travel" }], defaultId: "main", mainKey: "main" });
    await settleLitElement(page);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("prevents Escape/backdrop dismissal until apply settles", async () => {
    const pending = createDeferred<unknown>();
    const { page, click, input } = await mount({
      handler: (method) => (method === "claws.add.apply" ? pending.promise : undefined),
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    await click("Confirm changes");
    const event = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    page.querySelector("openclaw-modal-dialog")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    pending.resolve({
      schemaVersion: "openclaw.clawsGatewayApply.v1",
      operation: "add",
      status: "complete",
      agentId: "travel",
      message: "Completed",
    });
    await settleLitElement(page);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  });
  it("retains an unconfirmed write warning when reconciliation fails and later recovers", async () => {
    let readFails = false;
    const { page, click, input } = await mount({
      handler: (method) => {
        if (method === "claws.add.apply") {
          readFails = true;
          return Promise.reject(new Error("Connection lost"));
        }
        if (method === "claws.status" && readFails) {
          return Promise.reject(new Error("Inventory unavailable"));
        }
      },
    });
    await click("Add Claw");
    await input("packageName", clawRecord.name);
    await click("Review changes");
    await click("Confirm changes");
    expect(page.textContent).toContain("operation was not confirmed");
    expect(page.textContent).toContain("Inventory unavailable");
    readFails = false;
    await click("Refresh");
    expect(page.textContent).toContain("operation was not confirmed");
    expect(page.textContent).not.toContain("Inventory unavailable");
  });
});
