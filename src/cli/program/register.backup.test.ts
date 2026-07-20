// Register backup tests cover backup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupActivateManagedCommand: vi.fn(),
  managedRestoreRequestFailure: vi.fn(),
  readManagedRestoreRequestFromStdin: vi.fn(),
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
