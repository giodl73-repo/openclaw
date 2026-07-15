import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]);

export async function syncFileContent(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, fsConstants.O_WRONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryEntry(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function ensureDurableDirectoryTree(
  directoryPath: string,
  options: {
    allowExistingSymlink?: boolean;
    mode?: number;
    requirePrivateExisting?: boolean;
  } = {},
): Promise<void> {
  const mode = options.mode ?? 0o700;
  const missing: string[] = [];
  let probe = directoryPath;
  while (true) {
    try {
      const existing = await fs.lstat(probe);
      const existingDirectory =
        existing.isDirectory() ||
        (options.allowExistingSymlink === true &&
          existing.isSymbolicLink() &&
          (await fs.stat(probe)).isDirectory());
      if (!existingDirectory) {
        throw new Error(`Durable directory path is not a directory: ${probe}`);
      }
      if (
        options.requirePrivateExisting === true &&
        process.platform !== "win32" &&
        (existing.mode & 0o077) !== 0
      ) {
        throw new Error(`Durable directory permissions are too broad: ${probe}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw error;
      }
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
  for (const segment of missing.toReversed()) {
    const parent = probe;
    probe = path.join(probe, segment);
    try {
      await fs.mkdir(probe, { mode });
      await fs.chmod(probe, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = await fs.lstat(probe);
      if (
        existing.isSymbolicLink() ||
        !existing.isDirectory() ||
        (options.requirePrivateExisting === true &&
          process.platform !== "win32" &&
          (existing.mode & 0o077) !== 0)
      ) {
        throw new Error(`Concurrent durable directory is invalid: ${probe}`, { cause: error });
      }
    }
    await syncDirectoryEntry(parent);
  }
}
