// @vitest-environment node
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

it("renders both same-source model views in the real chat", { timeout: 120_000 }, async () => {
  const urls = [
    "/__openclaw__/canvas/documents/proof-one/index.html",
    "/__openclaw__/canvas/documents/proof-two/index.html",
  ];
  const sessionKey = "agent:main:main";
  const server = await startControlUiE2eServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
    await page.route("**/__openclaw__/canvas/documents/proof-*/index.html", async (route) => {
      const second = route.request().url().includes("proof-two");
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body style="margin:0;padding:24px;font:16px Arial;background:${second ? "#eef8f2" : "#eff6ff"};color:#17251f"><h2>${second ? "Capacity" : "Schedule"}</h2><p>${second ? "8 slots available" : "Review at 10:00"}</p></body></html>`,
      });
    });
    await installMockGateway(page, {
      assistantName: "Claw",
      historyMessages: [
        { role: "user", content: "Show the schedule and capacity.", timestamp: 1_000 },
        {
          role: "toolResult",
          toolCallId: "tool-call",
          toolName: "canvas",
          __openclaw: { id: "tool-result", seq: 2 },
          timestamp: 2_000,
          content: JSON.stringify({
            kind: "canvas",
            view: { url: urls[0], title: "Schedule", preferred_height: 180 },
          }),
          details: {
            uiArtifacts: urls.map((url, index) => ({
              version: 1,
              id: `artifact-${index}`,
              revision: 1,
              state: "ready",
              source: {
                sessionKey,
                messageId: "tool-result",
                toolCallId: "tool-call",
                toolName: "canvas",
              },
              views: [
                {
                  id: `view-${index}`,
                  templateUri: "openclaw://canvas",
                  dataVersion: 1,
                  availability: "deferred",
                  fallback: { kind: "canvas", url, sandbox: "strict" },
                },
              ],
            })),
          },
        },
        { role: "assistant", content: "Here are both views.", timestamp: 3_000 },
      ],
    });
    await page.goto(`${server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
    await page.getByText("Here are both views.", { exact: true }).waitFor({ timeout: 60_000 });
    await expectBrowser(page.locator(`iframe[src$="${urls[0]}"]`)).toHaveCount(1);
    await expectBrowser(
      page.frameLocator(`iframe[src$="${urls[0]}"]`).getByText("Review at 10:00"),
    ).toBeVisible();
    if (await page.locator(`iframe[src$="${urls[1]}"]`).count()) {
      await expectBrowser(
        page.frameLocator(`iframe[src$="${urls[1]}"]`).getByText("8 slots available"),
      ).toBeVisible();
    }
    const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactParent
      ? createControlUiE2eArtifactDir("model-artifact-siblings", artifactParent)
      : undefined;
    for (const [label, width, height] of [
      ["desktop", 1366, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, `model-artifact-siblings-${label}.png`),
        });
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    }
    await expectBrowser(page.locator(`iframe[src$="${urls[1]}"]`)).toHaveCount(1);
  } finally {
    await browser?.close();
    await server.close();
  }
});
