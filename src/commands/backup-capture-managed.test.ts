import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContinuityArchivePlanFromPaths } from "../continuity/archive-plan.js";
import type { ContinuityArchivePlan } from "../continuity/archive-plan.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  executeManagedFinalCapture,
  parseManagedFinalCaptureRequest,
  type ManagedFinalCaptureRequest,
} from "./backup-capture-managed.js";
import { verifyBackupArchive } from "./backup-verify.js";

const OWNER_ID = `sha256:${"1".repeat(64)}`;
const EXECUTION_ID = `sha256:${"2".repeat(64)}`;
const CHANGED_EXECUTION_ID = `sha256:${"3".repeat(64)}`;
const CAPTURED_AT_MS = Date.UTC(2026, 6, 14, 12, 0, 0);
const roots: string[] = [];

async function createFixture(): Promise<{
  root: string;
  plan: ContinuityArchivePlan;
  request: ManagedFinalCaptureRequest;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-capture-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config", "openclaw.json");
  const oauthDir = path.join(stateDir, "credentials");
  const workspaceDir = path.join(root, "workspace");
  const outputDir = path.join(root, "output");
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "runtime.json"), '{"closed":true}\n');
  await fs.writeFile(path.join(oauthDir, "oauth.json"), '{"accessToken":"secret"}\n');
  await fs.writeFile(configPath, "{}\n");
  await fs.writeFile(path.join(workspaceDir, "README.md"), "closed workspace\n");
  const plan = resolveContinuityArchivePlanFromPaths({
    stateDir,
    configPath,
    configRaw: "{}\n",
    oauthDir,
    workspaceDirs: [workspaceDir],
    uiHints: {},
    extensionMetadataComplete: true,
    allowedConfigRoots: [root],
    nowMs: CAPTURED_AT_MS,
  });
  const request: ManagedFinalCaptureRequest = {
    version: "continuity-final-capture/v1",
    authority: {
      ownerId: OWNER_ID,
      ownerGeneration: "generation-7",
      holdRevision: 11,
      handoffIdentity: "handoff-7",
      captureIdentity: "capture-7",
      executionIncarnationIdentity: EXECUTION_ID,
    },
    capture: {
      capturedAtMs: CAPTURED_AT_MS,
      outputPath: path.join(outputDir, "continuity.tar.gz"),
      stagingParent: path.join(root, "staging"),
    },
    journalRoot: path.join(root, "journal"),
  };
  return { root, plan, request };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed final continuity capture", () => {
  it("creates a verified artifact without OAuth credentials", async () => {
    const { plan, request } = await createFixture();

    const result = await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
    });
    const verified = await verifyBackupArchive({ archive: result.archivePath });

    expect(result).toMatchObject({
      ok: true,
      ownerId: OWNER_ID,
      ownerGeneration: "generation-7",
      holdRevision: 11,
      handoffIdentity: "handoff-7",
      captureIdentity: "capture-7",
      executionIncarnationIdentity: EXECUTION_ID,
      capturedAtMs: CAPTURED_AT_MS,
      oauthExcluded: true,
      stagingCleaned: true,
      continuityCapture: {
        targetLevel: "archived",
        eligible: true,
        evidence: {
          configFileCount: 1,
          workspaceCount: 1,
          oauthExcluded: true,
        },
      },
      continuityWake: {
        version: "continuity-wake-descriptor/v1",
        nextRequiredAt: null,
        reasonClass: "none",
      },
    });
    expect(result.continuityWake.schedulerGeneration).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      verified.manifest.assets.some((entry) => entry.archivePath.includes("credentials")),
    ).toBe(false);
    expect(verified.result.createdAt).toBe(new Date(CAPTURED_AT_MS).toISOString());
    await expect(fs.readFile(path.join(request.journalRoot, "ignored"))).rejects.toThrow();
  });

  it("returns the exact committed result on same-incarnation replay", async () => {
    const { plan, request } = await createFixture();
    const hooks = { resolvePlan: async () => plan };

    const first = await executeManagedFinalCapture(request, hooks);
    const replay = await executeManagedFinalCapture(request, hooks);

    expect(replay).toStrictEqual(first);
  });

  it("commits the exact closed scheduler wake descriptor", async () => {
    const { plan, request } = await createFixture();
    const continuityWake = {
      version: "continuity-wake-descriptor/v1" as const,
      schedulerGeneration: `sha256:${"4".repeat(64)}`,
      nextRequiredAt: "2026-07-17T03:00:00.000Z",
      reasonClass: "cron" as const,
    };

    const first = await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
      resolveWakeDescriptor: async () => continuityWake,
    });
    const replay = await executeManagedFinalCapture(request, {
      resolvePlan: async () => {
        throw new Error("live plan must not be consulted");
      },
      resolveWakeDescriptor: async () => {
        throw new Error("live scheduler must not be consulted");
      },
    });

    expect(first.continuityWake).toStrictEqual(continuityWake);
    expect(replay).toStrictEqual(first);
    const journalDir = path.join(request.journalRoot, sha256Hex(request.authority.captureIdentity));
    const intent = JSON.parse(await fs.readFile(path.join(journalDir, "intent.json"), "utf8"));
    expect(intent.continuityWake).toStrictEqual(continuityWake);
  });

  it("quarantines a committed result with a malformed wake descriptor", async () => {
    const { plan, request } = await createFixture();
    const first = await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
    });
    const journalDir = path.join(request.journalRoot, sha256Hex(request.authority.captureIdentity));
    await fs.writeFile(
      path.join(journalDir, "result.json"),
      JSON.stringify({
        ...first,
        continuityWake: {
          ...first.continuityWake,
          nextRequiredAt: "not-a-date",
          reasonClass: "cron",
        },
      }),
    );

    await expect(
      executeManagedFinalCapture(request, {
        resolvePlan: async () => {
          throw new Error("live config must not be consulted");
        },
      }),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("reuses the journaled wake descriptor after an interrupted capture", async () => {
    const { plan, request } = await createFixture();
    const frozenWake = {
      version: "continuity-wake-descriptor/v1" as const,
      schedulerGeneration: `sha256:${"4".repeat(64)}`,
      nextRequiredAt: "2026-07-17T03:00:00.000Z",
      reasonClass: "cron" as const,
    };
    await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
      resolveWakeDescriptor: async () => frozenWake,
    });
    const journalDir = path.join(request.journalRoot, sha256Hex(request.authority.captureIdentity));
    await fs.rm(path.join(journalDir, "result.json"));
    await fs.rm(request.capture.outputPath);

    const retry = await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
      resolveWakeDescriptor: async () => {
        throw new Error("live scheduler must not be consulted");
      },
    });

    expect(retry.continuityWake).toStrictEqual(frozenWake);
  });

  it("replays a committed result without resolving live configuration again", async () => {
    const { plan, request } = await createFixture();
    const first = await executeManagedFinalCapture(request, {
      resolvePlan: async () => plan,
    });

    const replay = await executeManagedFinalCapture(request, {
      resolvePlan: async () => {
        throw new Error("live config unavailable");
      },
    });

    expect(replay).toStrictEqual(first);
  });

  it("reconciles concurrent identical captures to one committed result", async () => {
    const { plan, request } = await createFixture();
    let releasePublished: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      releasePublished = resolve;
    });
    const hooks = {
      resolvePlan: async () => plan,
      afterArchiveCreated: async () => {
        releasePublished?.();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 750);
        });
      },
    };

    const firstPromise = executeManagedFinalCapture(request, hooks);
    await published;
    const secondPromise = executeManagedFinalCapture(request, hooks);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second).toStrictEqual(first);
  });

  it("rejects a changed execution incarnation for the same capture identity", async () => {
    const { plan, request } = await createFixture();
    const hooks = { resolvePlan: async () => plan };
    await executeManagedFinalCapture(request, hooks);

    await expect(
      executeManagedFinalCapture(
        {
          ...request,
          authority: {
            ...request.authority,
            executionIncarnationIdentity: CHANGED_EXECUTION_ID,
          },
        },
        hooks,
      ),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("holds a blocked capture plan without creating an artifact", async () => {
    const { plan, request } = await createFixture();
    const blockedPlan: ContinuityArchivePlan = {
      ...plan,
      eligible: false,
      blockers: [{ code: "continuity.capture.legacy_delivery_queue", count: 1 }],
    };

    await expect(
      executeManagedFinalCapture(request, {
        resolvePlan: async () => blockedPlan,
      }),
    ).rejects.toMatchObject({
      phase: "plan",
      code: "continuity.capture.plan_blocked",
      disposition: "hold",
      blockers: ["continuity.capture.legacy_delivery_queue"],
    });
    await expect(fs.access(request.capture.outputPath)).rejects.toThrow();
  });

  it("returns a typed retry when authoritative plan resolution fails", async () => {
    const { request } = await createFixture();

    await expect(
      executeManagedFinalCapture(request, {
        resolvePlan: async () => {
          throw new Error("config unavailable");
        },
      }),
    ).rejects.toMatchObject({
      phase: "plan",
      code: "continuity.capture.plan_failed",
      disposition: "retry-same-capture",
    });
  });

  it("quarantines an output that exists without a committed result", async () => {
    const { plan, request } = await createFixture();
    await fs.mkdir(path.dirname(request.capture.outputPath), { recursive: true });
    await fs.writeFile(request.capture.outputPath, "foreign");

    await expect(
      executeManagedFinalCapture(request, {
        resolvePlan: async () => plan,
      }),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("quarantines malformed journal evidence", async () => {
    const { plan, request } = await createFixture();
    const journalDir = path.join(request.journalRoot, sha256Hex(request.authority.captureIdentity));
    await fs.mkdir(journalDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(journalDir, "intent.json"), "{");

    await expect(
      executeManagedFinalCapture(request, {
        resolvePlan: async () => plan,
      }),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("rejects a journal path whose symlink ancestor resolves into captured state", async () => {
    const { root, plan, request } = await createFixture();
    const alias = path.join(root, "state-alias");
    await fs.symlink(
      plan.sources.state.sourcePath,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      executeManagedFinalCapture(
        {
          ...request,
          journalRoot: path.join(alias, "capture-journal"),
        },
        {
          resolvePlan: async () => plan,
        },
      ),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("rejects an archive output beneath the journal root", async () => {
    const { plan, request } = await createFixture();

    await expect(
      executeManagedFinalCapture(
        {
          ...request,
          capture: {
            ...request.capture,
            outputPath: path.join(request.journalRoot, "continuity.tar.gz"),
          },
        },
        {
          resolvePlan: async () => plan,
        },
      ),
    ).rejects.toMatchObject({
      phase: "journal",
      code: "continuity.capture.journal_conflict",
      disposition: "quarantine",
    });
  });

  it("publishes through an existing symlinked output directory", async () => {
    const { root, plan, request } = await createFixture();
    const target = path.join(root, "archive-target");
    const alias = path.join(root, "archive-alias");
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

    const result = await executeManagedFinalCapture(
      {
        ...request,
        capture: {
          ...request.capture,
          outputPath: path.join(alias, "continuity.tar.gz"),
        },
      },
      {
        resolvePlan: async () => plan,
      },
    );

    expect(result.ok).toBe(true);
    await expect(fs.access(path.join(target, "continuity.tar.gz"))).resolves.toBeUndefined();
  });

  it("rejects unknown request fields", () => {
    const raw = JSON.stringify({
      version: "continuity-final-capture/v1",
      authority: {},
      capture: {},
      journalRoot: "C:\\journal",
      command: "arbitrary",
    });

    expect(() => parseManagedFinalCaptureRequest(raw)).toThrow(/unknown=\[command\]/u);
  });

  it("canonicalizes trailing separators before journaling and replay", async () => {
    const { plan, request } = await createFixture();
    const parsed = parseManagedFinalCaptureRequest(
      JSON.stringify({
        ...request,
        capture: {
          ...request.capture,
          outputPath: `${request.capture.outputPath}${path.sep}`,
        },
      }),
    );

    expect(parsed.capture.outputPath).toBe(request.capture.outputPath);
    const first = await executeManagedFinalCapture(parsed, {
      resolvePlan: async () => plan,
    });
    const replay = await executeManagedFinalCapture(parsed, {
      resolvePlan: async () => {
        throw new Error("live config unavailable");
      },
    });
    expect(replay).toStrictEqual(first);
  });

  it("rejects oversized requests", () => {
    expect(() => parseManagedFinalCaptureRequest("x".repeat(256 * 1024 + 1))).toThrow(
      /request is too large/u,
    );
  });
});
