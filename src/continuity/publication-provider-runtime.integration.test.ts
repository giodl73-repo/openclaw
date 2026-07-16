import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContinuityPublicationProviderRuntimeV1 } from "./publication-provider-runtime.js";
import {
  publishContinuityArtifactV1,
  retrieveContinuityArtifactV1,
  type ContinuityPublicationIdentityV1,
} from "./publication-provider.js";

const tempDirs: string[] = [];
const pluginRoot = fileURLToPath(
  new URL("../../test/fixtures/continuity-publication-plugin/", import.meta.url),
);
const processFixture = fileURLToPath(
  new URL("../../test/fixtures/continuity-publication-process.ts", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("external continuity publication provider", () => {
  it("publishes and retrieves through fresh scoped registry loads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-provider-"));
    tempDirs.push(root);
    const publicationRoot = path.join(root, "published");
    const config = {
      continuity: {
        level: "portable",
        publicationProvider: "fixture/continuity",
      },
      plugins: {
        load: { paths: [pluginRoot] },
        allow: ["continuity-publication-fixture"],
        entries: {
          "continuity-publication-fixture": {
            enabled: true,
            config: {
              publicationRoot,
              generation: "fixture-7",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const bytes = Buffer.from("external portable continuity");
    const identity: ContinuityPublicationIdentityV1 = {
      ownerId: "tenant/cell-1",
      sourceRuntimeGeneration: "runtime-7",
      handoffId: "handoff-7",
      captureId: "capture-7",
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      manifestSha256: "a".repeat(64),
      archiveSize: bytes.byteLength,
    };

    const source = resolveContinuityPublicationProviderRuntimeV1({ config });
    const receipt = await publishContinuityArtifactV1({
      registry: source.registry,
      reference: source.reference,
      identity,
      content: (async function* () {
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
      })(),
      signal: new AbortController().signal,
    });

    const destination = resolveContinuityPublicationProviderRuntimeV1({ config });
    expect(destination.registry).not.toBe(source.registry);
    const retrieval = await retrieveContinuityArtifactV1({
      registry: destination.registry,
      reference: destination.reference,
      receipt,
      expectedOwnerId: identity.ownerId,
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of retrieval.content) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(receipt).toMatchObject({
      publicationPluginId: "continuity-publication-fixture",
      publicationBindingId: "fixture/continuity",
      publicationBindingVersion: "continuity-publication-provider/v1",
      publicationBindingGeneration: "fixture-7",
    });
  });

  it("retrieves after the publishing process exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-process-"));
    tempDirs.push(root);
    const bytes = Buffer.from("external cross-process portable continuity");
    const requestPath = path.join(root, "request.json");
    const receiptPath = path.join(root, "receipt.json");
    const retrievedPath = path.join(root, "retrieved.json");
    await fs.writeFile(
      requestPath,
      JSON.stringify({
        pluginRoot,
        publicationRoot: path.join(root, "published"),
        receiptPath,
        retrievedPath,
        bytesBase64: bytes.toString("base64"),
        identity: {
          ownerId: "tenant/cell-1",
          sourceRuntimeGeneration: "runtime-8",
          handoffId: "handoff-8",
          captureId: "capture-8",
          archiveSha256: createHash("sha256").update(bytes).digest("hex"),
          manifestSha256: "b".repeat(64),
          archiveSize: bytes.byteLength,
        },
      }),
      "utf8",
    );

    const publish = spawnSync(
      process.execPath,
      ["--import", "tsx", processFixture, "publish", requestPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(publish.status, publish.stderr).toBe(0);

    const retrieve = spawnSync(
      process.execPath,
      ["--import", "tsx", processFixture, "retrieve", requestPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(retrieve.status, retrieve.stderr).toBe(0);

    const result = JSON.parse(await fs.readFile(retrievedPath, "utf8")) as {
      publisherPid: number;
      retrieverPid: number;
      bytesBase64: string;
    };
    expect(result.publisherPid).not.toBe(result.retrieverPid);
    expect(Buffer.from(result.bytesBase64, "base64")).toEqual(bytes);
  });
});
