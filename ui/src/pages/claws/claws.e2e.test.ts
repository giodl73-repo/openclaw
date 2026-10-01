import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  blockedClawPluginPlan,
  clawDetail,
  clawDoctor,
  clawMethods,
  clawPlan,
  clawRecord,
  clawStatus,
} from "./claws.test-support.ts";

describe("Claws lifecycle in Plugins", () => {
  let server: ControlUiE2eServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { width: 1440, height: 1000 },
    { width: 393, height: 852 },
  ])(
    "shows configured update permissions and preserves blockers at $width px",
    async (viewport) => {
      const artifacts = createControlUiE2eArtifactDir(`claws-permissions-${viewport.width}`);
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const plan = blockedClawPluginPlan("update");
        plan.effectivePermissions!.desired!.tools.allowed.push(
          "core_tool_with_a_long_configuration_identifier_for_mobile_wrapping",
        );
        plan.effectivePermissions!.desired!.subagentTargets.explicitAgentIds.push(
          "research-agent-with-a-long-configured-identifier-for-mobile-permission-preview-wrapping",
        );
        const gateway = await installMockGateway(page, {
          featureMethods: clawMethods,
          operatorScopes: ["operator.admin", "operator.read"],
          methodResponses: {
            "claws.status": clawStatus(),
            "claws.doctor": clawDoctor,
            "claws.catalog.detail": {
              schemaVersion: "openclaw.clawsCatalogDetail.v1",
              detail: clawDetail,
            },
            "claws.update.plan": plan,
          },
        });
        await page.goto(`${server.baseUrl}claws`);
        await page.locator(".claws-row").click();
        await page.getByRole("button", { name: "Update", exact: true }).click();
        const disclosure = page.getByRole("region", {
          name: "Configured permissions",
          exact: true,
        });
        await disclosure.waitFor();
        const confirm = page.getByRole("button", { name: "Confirm changes", exact: true });
        expect(await confirm.isDisabled()).toBe(true);
        for (const [label, file] of [
          ["Configured permissions", "current"],
          ["After update", "desired"],
          ["Not resolved by this preview", "unresolved"],
          ["Package-declared scheduled jobs", "scheduled-coverage"],
        ]) {
          await page.getByRole("heading", { name: label, exact: true }).scrollIntoViewIfNeeded();
          expect(
            await page
              .locator(".claws-dialog")
              .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          ).toBe(true);
          await page.screenshot({
            path: path.join(artifacts, `${file}.png`),
            fullPage: false,
            animations: "disabled",
          });
        }
        for (const [label, file] of [
          ["Current: configured memory search", "current-memory"],
          ["Current: subagent target policy", "current-subagent-targets"],
          ["After update: configured memory search", "desired-memory"],
          ["After update: subagent target policy", "desired-subagent-targets"],
          ["daily-review", "scheduled-changed"],
          ["retired-review", "scheduled-removed"],
          [
            "weekly-review-requiring-manual-reconciliation-of-package-declared-scheduler-state",
            "scheduled-manual",
          ],
        ]) {
          const section = page.getByRole("region", { name: label, exact: true });
          await section.scrollIntoViewIfNeeded();
          expect(
            await section.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const dialog = element.closest(".claws-dialog")!;
              const clip = dialog.getBoundingClientRect();
              return (
                bounds.top >= Math.max(0, clip.top) - 1 &&
                bounds.bottom <= Math.min(innerHeight, clip.bottom) + 1 &&
                bounds.left >= Math.max(0, clip.left) - 1 &&
                bounds.right <= Math.min(innerWidth, clip.right) + 1 &&
                dialog.scrollWidth <= dialog.clientWidth + 1
              );
            }),
          ).toBe(true);
          await page.screenshot({
            path: path.join(artifacts, `${file}.png`),
            fullPage: false,
            animations: "disabled",
          });
        }
        await confirm.scrollIntoViewIfNeeded();
        expect(await page.getByRole("alert").textContent()).toContain(
          "Plugin capability consent is not available",
        );
        expect(await gateway.getRequests("claws.update.apply")).toHaveLength(0);
        await page.screenshot({
          path: path.join(artifacts, "blocked.png"),
          fullPage: false,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    { width: 1440, height: 1000 },
    { width: 393, height: 852 },
  ])(
    "reviews and applies the exact add, update, and remove requests at $width px",
    async (viewport) => {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const gateway = await installMockGateway(page, {
          featureMethods: clawMethods,
          operatorScopes: ["operator.admin", "operator.read"],
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", name: "Main" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "agent.identity.get": {
              cases: [
                {
                  match: { agentId: "main" },
                  response: {
                    agentId: "main",
                    name: "Main",
                    avatar: "",
                    avatarStatus: "none",
                    nameSource: "agent",
                  },
                },
                {
                  match: { agentId: "travel" },
                  response: {
                    agentId: "travel",
                    name: "Travel Concierge",
                    avatar: "",
                    avatarStatus: "none",
                    nameSource: "agent",
                  },
                },
              ],
            },
            "claws.status": clawStatus([]),
            "claws.doctor": clawDoctor,
            "claws.catalog.detail": {
              schemaVersion: "openclaw.clawsCatalogDetail.v1",
              detail: { ...clawDetail, publisher: "openclaw" },
            },
            "claws.add.plan": {
              ...clawPlan(),
              target: { ...clawPlan().target, publisher: "openclaw" },
            },
            "claws.update.plan": {
              ...clawPlan("update"),
              target: { ...clawPlan("update").target, publisher: "openclaw" },
            },
            "claws.remove.plan": clawPlan("remove"),
            ...Object.fromEntries(
              ["add", "update", "remove"].map((operation) => [
                `claws.${operation}.apply`,
                {
                  schemaVersion: "openclaw.clawsGatewayApply.v1",
                  operation,
                  status: "complete",
                  agentId: "travel",
                  message: "Completed",
                },
              ]),
            ),
          },
        });
        await page.goto(`${server.baseUrl}claws`);
        await page.getByText("No Claws installed.", { exact: true }).waitFor();
        expect(await page.getByRole("tab", { name: "Claws", exact: true }).count()).toBe(1);
        await page.getByRole("button", { name: "Add Claw", exact: true }).click();
        await page
          .getByRole("textbox", { name: "ClawHub package", exact: true })
          .fill(clawRecord.name);
        await page.getByRole("button", { name: "Review changes", exact: true }).click();
        await page.getByRole("button", { name: "Confirm changes", exact: true }).waitFor();
        expect(await page.locator(".claws-dialog").textContent()).toContain("openclaw");
        expect(await gateway.getRequests("claws.add.apply")).toHaveLength(0);
        await gateway.setMethodResponse(
          "claws.status",
          clawStatus([{ ...clawRecord, version: "0.2.0" }]),
        );
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        await page.locator(".claws-row").waitFor();
        expect((await gateway.waitForRequest("claws.add.apply")).params).toEqual({
          source: { packageName: clawRecord.name, version: "0.2.0" },
          planIntegrity: "reviewed-exact-plan",
        });
        await gateway.setMethodResponse("agents.list", {
          agents: [
            { id: "main", name: "Main" },
            { id: "travel", name: "Travel Concierge" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        });
        await page.getByRole("button", { name: "Continue setup in chat", exact: true }).click();
        await page.waitForURL("**/new?agent=travel");
        await page
          .locator(".new-session-page__select--agent .agent-select__label")
          .filter({ hasText: "Travel Concierge" })
          .waitFor();
        await page.goBack();
        await page.locator(".claws-row").click();
        await gateway.setMethodResponse("claws.catalog.detail", {
          schemaVersion: "openclaw.clawsCatalogDetail.v1",
          detail: { ...clawDetail, version: "0.3.0" },
        });
        await gateway.setMethodResponse("claws.update.plan", {
          ...clawPlan("update"),
          target: {
            ...clawPlan("update").target,
            currentVersion: "0.2.0",
            targetVersion: "0.3.0",
            publisher: "openclaw",
          },
        });
        await page.getByRole("button", { name: "Update", exact: true }).click();
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        expect((await gateway.waitForRequest("claws.update.apply")).params).toEqual({
          target: "travel",
          source: { packageName: clawRecord.name, version: "0.3.0" },
          planIntegrity: "reviewed-exact-plan",
        });
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await page.getByRole("button", { name: "Confirm changes", exact: true }).waitFor();
        expect(await page.locator(".claws-dialog").textContent()).toContain("preserve");
        await gateway.setMethodResponse("claws.status", clawStatus([]));
        await page.getByRole("button", { name: "Confirm changes", exact: true }).click();
        await page.getByText("No Claws installed.", { exact: true }).waitFor();
        expect((await gateway.waitForRequest("claws.remove.apply")).params).toEqual({
          target: "travel",
          removeUnused: false,
          planIntegrity: "reviewed-exact-plan",
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
  );
});
