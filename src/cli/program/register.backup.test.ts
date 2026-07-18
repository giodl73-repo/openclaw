// Register backup tests cover backup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupActivateManagedCommand: vi.fn(),
  managedRestoreRequestFailure: vi.fn(),
  readManagedRestoreRequestFromStdin: vi.fn(),
  backupCaptureManagedCommand: vi.fn(),
  managedFinalCaptureRequestFailure: vi.fn(),
  readManagedFinalCaptureRequestFromStdin: vi.fn(),
  backupPublishManagedCommand: vi.fn(),
  backupPublishManagedRetrievalCommand: vi.fn(),
  managedPublicationRequestFailure: vi.fn(),
  readManagedPublicationRequestFromStdin: vi.fn(),
  backupPrepareManagedCommand: vi.fn(),
  managedPreparationRequestFailure: vi.fn(),
  readManagedPreparationRequestFromStdin: vi.fn(),
  backupCreateCommand: vi.fn(),
  backupMaterializeCommand: vi.fn(),
  backupPlanRestoreCommand: vi.fn(),
  backupRetrieveCommand: vi.fn(),
  backupVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const backupCreateCommand = mocks.backupCreateCommand;
const backupVerifyCommand = mocks.backupVerifyCommand;
const runtime = mocks.runtime;

vi.mock("../../commands/backup-activate-managed.js", () => ({
  backupActivateManagedCommand: mocks.backupActivateManagedCommand,
  managedRestoreRequestFailure: mocks.managedRestoreRequestFailure,
  readManagedRestoreRequestFromStdin: mocks.readManagedRestoreRequestFromStdin,
}));

vi.mock("../../commands/backup-capture-managed.js", () => ({
  backupCaptureManagedCommand: mocks.backupCaptureManagedCommand,
  managedFinalCaptureRequestFailure: mocks.managedFinalCaptureRequestFailure,
  readManagedFinalCaptureRequestFromStdin: mocks.readManagedFinalCaptureRequestFromStdin,
}));

vi.mock("../../commands/backup-publish-managed.js", () => ({
  backupPublishManagedCommand: mocks.backupPublishManagedCommand,
  backupPublishManagedRetrievalCommand: mocks.backupPublishManagedRetrievalCommand,
  managedPublicationRequestFailure: mocks.managedPublicationRequestFailure,
  readManagedPublicationRequestFromStdin: mocks.readManagedPublicationRequestFromStdin,
}));

vi.mock("../../commands/backup-prepare-managed.js", () => ({
  backupPrepareManagedCommand: mocks.backupPrepareManagedCommand,
  managedPreparationRequestFailure: mocks.managedPreparationRequestFailure,
  readManagedPreparationRequestFromStdin: mocks.readManagedPreparationRequestFromStdin,
}));

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

vi.mock("../../commands/backup-materialize.js", () => ({
  backupMaterializeCommand: mocks.backupMaterializeCommand,
}));

vi.mock("../../commands/backup-plan-restore.js", () => ({
  backupPlanRestoreCommand: mocks.backupPlanRestoreCommand,
}));

vi.mock("../../commands/backup-retrieve.js", () => ({
  backupRetrieveCommand: mocks.backupRetrieveCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand: mocks.backupVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerBackupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backupActivateManagedCommand.mockResolvedValue(undefined);
    mocks.readManagedRestoreRequestFromStdin.mockResolvedValue('{"version":"test"}');
    mocks.backupCaptureManagedCommand.mockResolvedValue(undefined);
    mocks.readManagedFinalCaptureRequestFromStdin.mockResolvedValue('{"version":"capture-test"}');
    mocks.backupPublishManagedCommand.mockResolvedValue(undefined);
    mocks.backupPublishManagedRetrievalCommand.mockResolvedValue(undefined);
    mocks.readManagedPublicationRequestFromStdin.mockResolvedValue('{"version":"publish-test"}');
    mocks.backupPrepareManagedCommand.mockResolvedValue(undefined);
    mocks.readManagedPreparationRequestFromStdin.mockResolvedValue('{"version":"prepare-test"}');
    backupCreateCommand.mockResolvedValue(undefined);
    mocks.backupMaterializeCommand.mockResolvedValue(undefined);
    mocks.backupPlanRestoreCommand.mockResolvedValue(undefined);
    mocks.backupRetrieveCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
  });

  function expectForwardedOptions(command: typeof backupCreateCommand): Record<string, unknown> {
    expect(command).toHaveBeenCalledTimes(1);
    const call = command.mock.calls[0];
    if (!call) {
      throw new Error("expected backup command call");
    }
    const [runtimeArg, options] = call as unknown as [typeof runtime, Record<string, unknown>];
    expect(runtimeArg).toBe(runtime);
    return options;
  }

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.output).toBe("/tmp/backups");
    expect(options.json).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.verify).toBe(false);
    expect(options.onlyConfig).toBe(false);
    expect(options.includeWorkspace).toBe(true);
  });

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "create", "--no-include-workspace"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.includeWorkspace).toBe(false);
  });

  it("forwards --verify to backup create", async () => {
    await runCli(["backup", "create", "--verify"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.verify).toBe(true);
  });

  it("forwards --only-config to backup create", async () => {
    await runCli(["backup", "create", "--only-config"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.onlyConfig).toBe(true);
  });

  it("runs backup verify with forwarded options", async () => {
    await runCli(["backup", "verify", "/tmp/openclaw-backup.tar.gz", "--json"]);

    const options = expectForwardedOptions(backupVerifyCommand);
    expect(options.archive).toBe("/tmp/openclaw-backup.tar.gz");
    expect(options.json).toBe(true);
  });

  it("runs backup retrieve with a required clean destination", async () => {
    await runCli([
      "backup",
      "retrieve",
      "/tmp/openclaw-backup.tar.gz",
      "--destination",
      "/tmp/restored",
      "--json",
    ]);

    const options = expectForwardedOptions(mocks.backupRetrieveCommand);
    expect(options).toStrictEqual({
      archive: "/tmp/openclaw-backup.tar.gz",
      destination: "/tmp/restored",
      json: true,
    });
  });

  it("materializes a continuity archive into a required clean destination", async () => {
    await runCli([
      "backup",
      "materialize",
      "/tmp/continuity.tar.gz",
      "--destination",
      "/tmp/offline-root",
      "--json",
    ]);

    const options = expectForwardedOptions(mocks.backupMaterializeCommand);
    expect(options).toStrictEqual({
      archive: "/tmp/continuity.tar.gz",
      destination: "/tmp/offline-root",
      json: true,
    });
  });

  it("runs managed activation from a strict stdin request", async () => {
    await runCli(["backup", "activate", "--managed", "--json"]);

    expect(mocks.readManagedRestoreRequestFromStdin).toHaveBeenCalledTimes(1);
    expect(mocks.backupActivateManagedCommand).toHaveBeenCalledWith(runtime, '{"version":"test"}', {
      json: true,
    });
  });

  it("runs managed final capture from a strict stdin request", async () => {
    await runCli(["backup", "capture", "--managed", "--json"]);

    expect(mocks.readManagedFinalCaptureRequestFromStdin).toHaveBeenCalledTimes(1);
    expect(mocks.backupCaptureManagedCommand).toHaveBeenCalledWith(
      runtime,
      '{"version":"capture-test"}',
      { json: true },
    );
  });

  it("runs managed publication from a strict stdin request", async () => {
    await runCli(["backup", "publish", "--managed", "--json"]);

    expect(mocks.readManagedPublicationRequestFromStdin).toHaveBeenCalledTimes(1);
    expect(mocks.backupPublishManagedCommand).toHaveBeenCalledWith(
      runtime,
      '{"version":"publish-test"}',
    );
  });

  it("runs managed preparation from a strict stdin request", async () => {
    await runCli(["backup", "prepare", "--managed", "--json"]);

    expect(mocks.readManagedPreparationRequestFromStdin).toHaveBeenCalledTimes(1);
    expect(mocks.backupPrepareManagedCommand).toHaveBeenCalledWith(
      runtime,
      '{"version":"prepare-test"}',
    );
  });

  it("returns a typed failure when the managed preparation request cannot be read", async () => {
    const error = new Error("request too large");
    mocks.readManagedPreparationRequestFromStdin.mockRejectedValue(error);

    await runCli(["backup", "prepare", "--managed", "--json"]);

    expect(mocks.managedPreparationRequestFailure).toHaveBeenCalledWith(runtime, error);
    expect(mocks.backupPrepareManagedCommand).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the managed publication request cannot be read", async () => {
    const error = new Error("request too large");
    mocks.readManagedPublicationRequestFromStdin.mockRejectedValue(error);

    await runCli(["backup", "publish", "--managed", "--json"]);

    expect(mocks.managedPublicationRequestFailure).toHaveBeenCalledWith(runtime, error);
    expect(mocks.backupPublishManagedCommand).not.toHaveBeenCalled();
  });

  it("runs internal fresh-process retrieval from a strict stdin request", async () => {
    await runCli(["backup", "publish-retrieve", "--managed", "--json"]);

    expect(mocks.readManagedPublicationRequestFromStdin).toHaveBeenCalledTimes(1);
    expect(mocks.backupPublishManagedRetrievalCommand).toHaveBeenCalledWith(
      runtime,
      '{"version":"publish-test"}',
    );
  });

  it("requires JSON output for managed final capture", async () => {
    await runCli(["backup", "capture", "--managed"]);

    expect(runtime.error).toHaveBeenCalledWith("backup capture requires --managed --json.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.readManagedFinalCaptureRequestFromStdin).not.toHaveBeenCalled();
    expect(mocks.backupCaptureManagedCommand).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the managed capture request cannot be read", async () => {
    const error = new Error("request too large");
    mocks.readManagedFinalCaptureRequestFromStdin.mockRejectedValue(error);

    await runCli(["backup", "capture", "--managed", "--json"]);

    expect(mocks.managedFinalCaptureRequestFailure).toHaveBeenCalledWith(runtime, error, {
      json: true,
    });
    expect(mocks.backupCaptureManagedCommand).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the managed stdin request cannot be read", async () => {
    const error = new Error("request too large");
    mocks.readManagedRestoreRequestFromStdin.mockRejectedValue(error);

    await runCli(["backup", "activate", "--managed", "--json"]);

    expect(mocks.managedRestoreRequestFailure).toHaveBeenCalledWith(runtime, error, { json: true });
    expect(mocks.backupActivateManagedCommand).not.toHaveBeenCalled();
  });

  it("plans exact restore roots without activating them", async () => {
    await runCli([
      "backup",
      "plan-restore",
      "/tmp/continuity.tar.gz",
      "--materialized",
      "/tmp/offline-root",
      "--authorize",
      "/tmp/live-state",
      "/tmp/live-config.json",
      "--json",
    ]);

    const options = expectForwardedOptions(mocks.backupPlanRestoreCommand);
    expect(options).toStrictEqual({
      archive: "/tmp/continuity.tar.gz",
      materialized: "/tmp/offline-root",
      authorize: ["/tmp/live-state", "/tmp/live-config.json"],
      json: true,
    });
  });
});
