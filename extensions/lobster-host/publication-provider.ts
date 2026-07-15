import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  ContinuityPublicationAcceptanceReceiptV1,
  ContinuityPublicationIdentityV1,
  ContinuityPublicationProviderAcceptanceV1,
  ContinuityPublicationProviderFailureCode,
  ContinuityPublicationProviderV1,
  ContinuityPublicationRetrievalV1,
} from "openclaw/plugin-sdk/types";

const PROVIDER_ID = "lobster/continuity";
const PROVIDER_VERSION = "continuity-publication-provider/v1";
const ACCEPTANCE_VERSION = "continuity-publication-acceptance/v1";
const RETRIEVAL_VERSION = "continuity-publication-retrieval/v1";
const METADATA_VERSION = "lobster-continuity-publication/v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type StoredPublication = {
  version: typeof METADATA_VERSION;
  publicationId: string;
  providerId: typeof PROVIDER_ID;
  providerGeneration: string;
  identity: ContinuityPublicationIdentityV1;
  durabilityClass: "immutable";
  acceptedAt: string;
};

function providerFailure(
  code: ContinuityPublicationProviderFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: ContinuityPublicationProviderFailureCode } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function isFileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isProviderFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    code === "retryable-before-commit" ||
    code === "outcome-unknown" ||
    code === "conflict" ||
    code === "corrupt-retrieval" ||
    code === "unavailable" ||
    code === "cancelled"
  );
}

function identitiesEqual(
  left: ContinuityPublicationIdentityV1,
  right: ContinuityPublicationIdentityV1,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.sourceRuntimeGeneration === right.sourceRuntimeGeneration &&
    left.handoffId === right.handoffId &&
    left.captureId === right.captureId &&
    left.archiveSha256 === right.archiveSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.archiveSize === right.archiveSize
  );
}

function hashIdentityPart(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isStoredPublication(value: unknown): value is StoredPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const identity = record.identity as Record<string, unknown> | undefined;
  const acceptedAt = record.acceptedAt;
  const acceptedAtTimestamp = typeof acceptedAt === "string" ? Date.parse(acceptedAt) : Number.NaN;
  return (
    Object.keys(record).length === 7 &&
    record.version === METADATA_VERSION &&
    typeof record.publicationId === "string" &&
    record.providerId === PROVIDER_ID &&
    typeof record.providerGeneration === "string" &&
    record.durabilityClass === "immutable" &&
    typeof acceptedAt === "string" &&
    Number.isFinite(acceptedAtTimestamp) &&
    new Date(acceptedAtTimestamp).toISOString() === acceptedAt &&
    identity !== undefined &&
    Object.keys(identity).length === 7 &&
    typeof identity.ownerId === "string" &&
    typeof identity.sourceRuntimeGeneration === "string" &&
    typeof identity.handoffId === "string" &&
    typeof identity.captureId === "string" &&
    typeof identity.archiveSha256 === "string" &&
    SHA256_PATTERN.test(identity.archiveSha256) &&
    typeof identity.manifestSha256 === "string" &&
    SHA256_PATTERN.test(identity.manifestSha256) &&
    Number.isSafeInteger(identity.archiveSize) &&
    Number(identity.archiveSize) >= 0
  );
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function ensureDurableDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (path.dirname(current) !== current) {
    try {
      const stat = await fs.stat(current);
      if (!stat.isDirectory()) {
        throw new Error(`Continuity publication path is not a directory: ${current}`);
      }
      break;
    } catch (error) {
      if (!isFileMissing(error)) {
        throw error;
      }
      missing.push(current);
      current = path.dirname(current);
    }
  }
  for (const target of missing.toReversed()) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        throw error;
      }
    }
    await syncDirectory(path.dirname(target));
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new Error("continuity publication write made no progress");
    }
    offset += result.bytesWritten;
  }
}

export class LobsterContinuityPublicationProvider implements ContinuityPublicationProviderV1 {
  readonly id = PROVIDER_ID;
  readonly version = PROVIDER_VERSION;

  constructor(
    private readonly publicationRoot: string,
    readonly generation: string,
  ) {}

  private publicationPaths(identity: ContinuityPublicationIdentityV1) {
    const ownerName = hashIdentityPart(identity.ownerId);
    const publicationName = hashIdentityPart(identity.ownerId, identity.handoffId);
    const directory = path.join(this.publicationRoot, "objects", ownerName, publicationName);
    return {
      directory,
      artifact: path.join(directory, "archive.bin"),
      metadata: path.join(directory, "metadata.json"),
      publicationId: `${PROVIDER_ID}/${publicationName}`,
    };
  }

  private async readStored(
    identity: ContinuityPublicationIdentityV1,
    failureCodes: {
      unavailable: "unavailable" | "corrupt-retrieval";
      corrupt: "conflict" | "corrupt-retrieval";
    },
  ): Promise<StoredPublication | undefined> {
    const paths = this.publicationPaths(identity);
    let raw: string;
    try {
      raw = await fs.readFile(paths.metadata, "utf8");
    } catch (error) {
      if (isFileMissing(error)) {
        return undefined;
      }
      throw providerFailure(
        failureCodes.unavailable,
        "Continuity publication metadata is unavailable",
        error,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw providerFailure(
        failureCodes.corrupt,
        "Continuity publication metadata is corrupt",
        error,
      );
    }
    if (!isStoredPublication(parsed)) {
      throw providerFailure(failureCodes.corrupt, "Continuity publication metadata is invalid");
    }
    if (parsed.publicationId !== paths.publicationId) {
      throw providerFailure(
        failureCodes.corrupt,
        "Continuity publication metadata identity is invalid",
      );
    }
    return parsed;
  }

  private requireReplay(
    stored: StoredPublication,
    identity: ContinuityPublicationIdentityV1,
  ): ContinuityPublicationProviderAcceptanceV1 {
    if (
      stored.providerGeneration !== this.generation ||
      !identitiesEqual(stored.identity, identity)
    ) {
      throw providerFailure(
        "conflict",
        "Continuity publication identity conflicts with the committed handoff",
      );
    }
    return {
      version: ACCEPTANCE_VERSION,
      publicationId: stored.publicationId,
      identity: stored.identity,
      durabilityClass: "immutable",
      acceptedAt: stored.acceptedAt,
    };
  }

  async publish(params: {
    identity: ContinuityPublicationIdentityV1;
    content: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }): Promise<ContinuityPublicationProviderAcceptanceV1> {
    if (params.signal.aborted) {
      throw providerFailure("cancelled", "Continuity publication was cancelled");
    }
    const existing = await this.readStored(params.identity, {
      unavailable: "unavailable",
      corrupt: "conflict",
    });
    if (existing) {
      return this.requireReplay(existing, params.identity);
    }

    const paths = this.publicationPaths(params.identity);
    const stagingRoot = path.join(this.publicationRoot, ".staging");
    const stagingDirectory = path.join(stagingRoot, randomUUID());
    const stagingArtifact = path.join(stagingDirectory, "archive.bin");
    const stagingMetadata = path.join(stagingDirectory, "metadata.json");
    let committed = false;
    try {
      await ensureDurableDirectory(path.dirname(paths.directory));
      await ensureDurableDirectory(stagingRoot);
      await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      const hash = createHash("sha256");
      let size = 0;
      const artifactHandle = await fs.open(stagingArtifact, "wx", 0o600);
      try {
        for await (const chunk of params.content) {
          if (params.signal.aborted) {
            throw providerFailure("cancelled", "Continuity publication was cancelled");
          }
          if (!(chunk instanceof Uint8Array)) {
            throw providerFailure("conflict", "Continuity publication content is invalid");
          }
          size += chunk.byteLength;
          if (!Number.isSafeInteger(size) || size > params.identity.archiveSize) {
            throw providerFailure(
              "conflict",
              "Continuity publication size does not match the trusted identity",
            );
          }
          await writeAll(artifactHandle, chunk);
          hash.update(chunk);
        }
        if (
          size !== params.identity.archiveSize ||
          hash.digest("hex") !== params.identity.archiveSha256
        ) {
          throw providerFailure(
            "conflict",
            "Continuity publication digest does not match the trusted identity",
          );
        }
        await artifactHandle.sync();
      } finally {
        await artifactHandle.close();
      }

      const stored: StoredPublication = {
        version: METADATA_VERSION,
        publicationId: paths.publicationId,
        providerId: PROVIDER_ID,
        providerGeneration: this.generation,
        identity: { ...params.identity },
        durabilityClass: "immutable",
        acceptedAt: new Date().toISOString(),
      };
      const metadataHandle = await fs.open(stagingMetadata, "wx", 0o600);
      try {
        await metadataHandle.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
        await metadataHandle.sync();
      } finally {
        await metadataHandle.close();
      }
      await syncDirectory(stagingDirectory);

      try {
        await fs.rename(stagingDirectory, paths.directory);
        committed = true;
      } catch (error) {
        const raced = await this.readStored(params.identity, {
          unavailable: "unavailable",
          corrupt: "conflict",
        });
        if (raced) {
          return this.requireReplay(raced, params.identity);
        }
        throw providerFailure(
          "outcome-unknown",
          "Continuity publication commit outcome is unknown",
          error,
        );
      }
      try {
        await syncDirectory(path.dirname(paths.directory));
      } catch (error) {
        throw providerFailure(
          "outcome-unknown",
          "Continuity publication durability outcome is unknown",
          error,
        );
      }
      return {
        version: ACCEPTANCE_VERSION,
        publicationId: stored.publicationId,
        identity: stored.identity,
        durabilityClass: "immutable",
        acceptedAt: stored.acceptedAt,
      };
    } catch (error) {
      if (isProviderFailure(error)) {
        throw error;
      }
      throw providerFailure(
        committed ? "outcome-unknown" : "retryable-before-commit",
        "Continuity publication failed",
        error,
      );
    } finally {
      if (!committed) {
        await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async retrieve(params: {
    receipt: ContinuityPublicationAcceptanceReceiptV1;
    signal: AbortSignal;
  }): Promise<ContinuityPublicationRetrievalV1> {
    if (params.signal.aborted) {
      throw providerFailure("cancelled", "Continuity publication retrieval was cancelled");
    }
    const stored = await this.readStored(params.receipt.identity, {
      unavailable: "corrupt-retrieval",
      corrupt: "corrupt-retrieval",
    });
    if (
      !stored ||
      stored.providerGeneration !== this.generation ||
      stored.publicationId !== params.receipt.publicationId ||
      stored.acceptedAt !== params.receipt.acceptedAt ||
      !identitiesEqual(stored.identity, params.receipt.identity)
    ) {
      throw providerFailure(
        "corrupt-retrieval",
        "Continuity publication metadata does not match the acceptance receipt",
      );
    }
    const paths = this.publicationPaths(params.receipt.identity);
    let stat;
    try {
      stat = await fs.stat(paths.artifact);
    } catch (error) {
      throw providerFailure(
        "corrupt-retrieval",
        "Continuity publication archive is unavailable",
        error,
      );
    }
    if (!stat.isFile() || stat.size !== stored.identity.archiveSize) {
      throw providerFailure("corrupt-retrieval", "Continuity publication archive is invalid");
    }
    const signal = params.signal;
    return {
      version: RETRIEVAL_VERSION,
      publicationId: stored.publicationId,
      identity: stored.identity,
      content: (async function* () {
        try {
          for await (const chunk of createReadStream(paths.artifact)) {
            if (signal.aborted) {
              throw providerFailure("cancelled", "Continuity publication retrieval was cancelled");
            }
            yield chunk;
          }
        } catch (error) {
          if (isProviderFailure(error)) {
            throw error;
          }
          throw providerFailure(
            "corrupt-retrieval",
            "Continuity publication archive could not be read",
            error,
          );
        }
      })(),
    };
  }
}
