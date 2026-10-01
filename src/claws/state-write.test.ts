import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), execute: vi.fn() }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.capture,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: mocks.run,
}));
import {
  withClawMutationGuard,
  updateClawInstallRecordStatusAsync,
  recordAgentProvenanceAsync,
} from "./state-write.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockReturnValue({ admission: "captured-owner" });
  mocks.run.mockImplementation(async (_context, operation, options) => {
    options.assertCurrent?.();
    await Promise.resolve();
    options.assertCurrent?.();
    return operation({ execute: mocks.execute });
  });
});

it("sends canonical finite state commands to the broker, without serializing environment or callbacks", async () => {
  const guard = vi.fn();
  await withClawMutationGuard(guard, () =>
    updateClawInstallRecordStatusAsync("assistant", "complete", {
      env: { PRIVATE_FIXTURE: "not-for-worker-command" },
      nowMs: 123,
      expectedStatuses: ["config_committed"],
    }),
  );
  expect(guard).toHaveBeenCalledTimes(2);
  expect(mocks.execute).toHaveBeenCalledWith({
    type: "claws.state.updateClawInstallRecordStatus",
    input: {
      args: ["assistant", "complete"],
      options: { nowMs: 123, expectedStatuses: ["config_committed"] },
    },
  });
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("PRIVATE_FIXTURE");
});

it("composes parent authority and rejects queued writes when that authority retires", async () => {
  let current = true;
  const parent = () => {
    if (!current) {
      throw new Error("retired");
    }
  };
  const child = vi.fn();
  mocks.run.mockImplementationOnce(async (_context, operation, options) => {
    options.assertCurrent();
    await Promise.resolve();
    current = false;
    options.assertCurrent();
    return operation({ execute: mocks.execute });
  });
  await expect(
    withClawMutationGuard(parent, () =>
      withClawMutationGuard(child, () =>
        recordAgentProvenanceAsync("assistant", { createdVia: "claw" }),
      ),
    ),
  ).rejects.toThrow("retired");
  expect(child).toHaveBeenCalledTimes(1);
  expect(mocks.execute).not.toHaveBeenCalled();
});
