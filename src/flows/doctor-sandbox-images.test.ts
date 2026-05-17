import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const mocks = vi.hoisted(() => ({
  built: false,
  runExec: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: mocks.runExec,
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  isDockerDaemonUnavailable: (message: string) => message.includes("Docker"),
  resolveSandboxScope: vi.fn(() => "shared"),
}));

describe("doctor sandbox image repair", () => {
  beforeEach(() => {
    mocks.built = false;
    mocks.runExec.mockReset();
    mocks.runCommandWithTimeout.mockReset();
    mocks.runExec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        if (mocks.built) {
          return { stdout: "[]", stderr: "" };
        }
        throw { stderr: "No such image" };
      }
      return { stdout: "", stderr: "" };
    });
    mocks.runCommandWithTimeout.mockImplementation(async () => {
      mocks.built = true;
      return { code: 0, stdout: "", stderr: "" };
    });
  });

  it("builds missing sandbox images through the structured health check", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/sandbox/images");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
          },
        },
      },
    };
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox/images",
        message: "Sandbox base image missing: default-image.",
        path: "default-image",
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg,
          doctor: {
            confirm: vi.fn(async () => true),
          },
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: ["Built base sandbox image default-image."],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg,
        },
        { findings },
      ),
    ).resolves.toEqual([]);
  });
});
