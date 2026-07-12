import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupRetrieveCommand } from "./backup-retrieve.js";
import { backupVerifyCommand } from "./backup-verify.js";

const ARCHIVE_ROOT = "2026-07-11T20-00-00.000Z-openclaw-backup";
const PAYLOAD_PATH = `${ARCHIVE_ROOT}/payload/posix/tmp/openclaw/state.txt`;

function encodeTarEntry(params: {
  path: string;
  contents?: string | Buffer;
  type?: "File" | "SymbolicLink";
  linkpath?: string;
}): Buffer {
  const body = Buffer.isBuffer(params.contents)
    ? params.contents
    : Buffer.from(params.contents ?? "");
  const header = new tar.Header({
    path: params.path,
    type: params.type ?? "File",
    size: params.type === "SymbolicLink" ? 0 : body.length,
    mode: 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (params.type === "SymbolicLink") {
    return headerBlock;
  }
  return Buffer.concat([headerBlock, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function manifest() {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-11T20:00:00.000Z",
    archiveRoot: ARCHIVE_ROOT,
    runtimeVersion: "test",
    platform: process.platform,
    nodeVersion: process.version,
    assets: [
      {
        kind: "state",
        sourcePath: "/tmp/openclaw",
        archivePath: PAYLOAD_PATH,
      },
    ],
  };
}

async function writeArchive(
  archivePath: string,
  options: {
    payload?: string;
    extraEntries?: Buffer[];
  } = {},
): Promise<void> {
  const archive = gzipSync(
    Buffer.concat([
      encodeTarEntry({
        path: `${ARCHIVE_ROOT}/manifest.json`,
        contents: `${JSON.stringify(manifest())}\n`,
      }),
      encodeTarEntry({
        path: PAYLOAD_PATH,
        contents: options.payload ?? "state\n",
      }),
      ...(options.extraEntries ?? []),
      Buffer.alloc(1024),
    ]),
  );
  await fs.writeFile(archivePath, archive);
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("backupRetrieveCommand", () => {
  it("retrieves a verified archive into a new non-active staging directory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-retrieve-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const destination = path.join(tempDir, "restored");
    try {
      await writeArchive(archivePath);
      const commandRuntime = runtime();
      const verification = await backupVerifyCommand(runtime(), { archive: archivePath });

      const result = await backupRetrieveCommand(commandRuntime, {
        archive: archivePath,
        destination,
      });

      expect(result).toMatchObject({
        ok: true,
        archivePath,
        destination,
        archiveRoot: ARCHIVE_ROOT,
        assetCount: 1,
      });
      expect(result.archiveSha256).toBe(verification.archiveSha256);
      expect(result.manifestSha256).toBe(verification.manifestSha256);
      expect(commandRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining("it has not been activated as live state"),
      );
      await expect(fs.readFile(path.join(destination, "manifest.json"), "utf8")).resolves.toContain(
        ARCHIVE_ROOT,
      );
      await expect(
        fs.readFile(
          path.join(destination, "payload", "posix", "tmp", "openclaw", "state.txt"),
          "utf8",
        ),
      ).resolves.toBe("state\n");
      await expect(
        fs.access(path.join(destination, ".openclaw-retrieve-incomplete")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing destination", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-existing-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const destination = path.join(tempDir, "restored");
    try {
      await writeArchive(archivePath);
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "sentinel"), "keep\n");

      await expect(
        backupRetrieveCommand(runtime(), { archive: archivePath, destination }),
      ).rejects.toThrow(/destination already exists/i);
      await expect(fs.readFile(path.join(destination, "sentinel"), "utf8")).resolves.toBe("keep\n");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects links and removes the incomplete destination", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-link-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const destination = path.join(tempDir, "restored");
    try {
      await writeArchive(archivePath, {
        extraEntries: [
          encodeTarEntry({
            path: `${ARCHIVE_ROOT}/payload/posix/tmp/openclaw/escape`,
            type: "SymbolicLink",
            linkpath: "../../../../outside",
          }),
        ],
      });

      await expect(
        backupRetrieveCommand(runtime(), { archive: archivePath, destination }),
      ).rejects.toThrow(/unsupported or unsafe retrieve entry/i);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces the expanded payload byte limit and removes partial output", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-limit-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const destination = path.join(tempDir, "restored");
    try {
      await writeArchive(archivePath, { payload: "x".repeat(16_000) });

      await expect(
        backupRetrieveCommand(runtime(), {
          archive: archivePath,
          destination,
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/payload exceeds the 1024-byte retrieve limit/i);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces the archive entry limit before creating the destination", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-entries-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const destination = path.join(tempDir, "restored");
    try {
      await writeArchive(archivePath, {
        extraEntries: [
          encodeTarEntry({
            path: `${ARCHIVE_ROOT}/payload/posix/tmp/openclaw/extra.txt`,
            contents: "extra\n",
          }),
        ],
      });

      await expect(
        backupRetrieveCommand(runtime(), {
          archive: archivePath,
          destination,
          maxEntries: 2,
        }),
      ).rejects.toThrow(/archive exceeds the 2-entry limit/i);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
