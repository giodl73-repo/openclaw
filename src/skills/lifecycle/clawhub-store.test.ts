import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

const atomic = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/fs-safe/atomic", () => ({
  replaceFileAtomic: atomic,
  replaceFileAtomicSync: vi.fn(),
}));
import { recordClawHubSkillInstall } from "./clawhub-store.js";

it("guards skill tracking publication after asynchronous staging and preserves JSON write semantics", async () => {
  let current = true;
  const publish = vi.fn();
  const origin = {
    version: 1 as const,
    slug: "assistant",
    registry: "https://clawhub.ai",
    installedVersion: "1.2.3",
    installedAt: 123,
  };
  atomic.mockImplementationOnce(async (options) => {
    expect(options).toMatchObject({
      content: `${JSON.stringify(origin, null, 2)}\n`,
      mode: 0o600,
      dirMode: 0o777 & ~process.umask(),
      syncTempFile: true,
      syncParentDir: true,
      copyFallbackOnPermissionError: true,
    });
    options.assertBeforeMutation();
    await Promise.resolve();
    current = false;
    options.assertBeforeMutation();
    publish();
  });
  await expect(
    recordClawHubSkillInstall({
      workspaceDir: resolve("fixture-workspace"),
      skillDir: resolve("fixture-workspace", "skills", "assistant"),
      origin,
      beforePersistentApply: () => {
        if (!current) {
          throw new Error("authority retired");
        }
      },
    }),
  ).rejects.toThrow("authority retired");
  expect(atomic).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});
