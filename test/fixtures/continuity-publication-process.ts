import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveContinuityPublicationProviderRuntimeV1 } from "../../src/continuity/publication-provider-runtime.js";
import {
  publishContinuityArtifactV1,
  retrieveContinuityArtifactV1,
  type ContinuityPublicationAcceptanceReceiptV1,
  type ContinuityPublicationIdentityV1,
} from "../../src/continuity/publication-provider.js";

type ProcessFixtureRequest = {
  pluginRoot: string;
  publicationRoot: string;
  receiptPath: string;
  retrievedPath: string;
  bytesBase64: string;
  identity: ContinuityPublicationIdentityV1;
};

function buildConfig(request: ProcessFixtureRequest): OpenClawConfig {
  return {
    continuity: {
      level: "portable",
      publicationProvider: "fixture/continuity",
    },
    plugins: {
      load: { paths: [request.pluginRoot] },
      allow: ["continuity-publication-fixture"],
      entries: {
        "continuity-publication-fixture": {
          enabled: true,
          config: {
            publicationRoot: request.publicationRoot,
            generation: "fixture-7",
          },
        },
      },
    },
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const requestPath = process.argv[3];
  if ((mode !== "publish" && mode !== "retrieve") || !requestPath) {
    throw new Error("continuity publication process fixture arguments are invalid");
  }
  const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as ProcessFixtureRequest;
  const runtime = resolveContinuityPublicationProviderRuntimeV1({
    config: buildConfig(request),
  });
  if (mode === "publish") {
    const bytes = Buffer.from(request.bytesBase64, "base64");
    const receipt = await publishContinuityArtifactV1({
      registry: runtime.registry,
      reference: runtime.reference,
      identity: request.identity,
      content: (async function* () {
        yield bytes;
      })(),
      signal: new AbortController().signal,
    });
    await fs.writeFile(
      request.receiptPath,
      JSON.stringify({ publisherPid: process.pid, receipt }),
      "utf8",
    );
    return;
  }

  const persisted = JSON.parse(await fs.readFile(request.receiptPath, "utf8")) as {
    publisherPid: number;
    receipt: ContinuityPublicationAcceptanceReceiptV1;
  };
  const retrieval = await retrieveContinuityArtifactV1({
    registry: runtime.registry,
    reference: runtime.reference,
    receipt: persisted.receipt,
    expectedOwnerId: request.identity.ownerId,
    signal: new AbortController().signal,
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of retrieval.content) {
    chunks.push(chunk);
  }
  await fs.writeFile(
    request.retrievedPath,
    JSON.stringify({
      publisherPid: persisted.publisherPid,
      retrieverPid: process.pid,
      bytesBase64: Buffer.concat(chunks).toString("base64"),
    }),
    "utf8",
  );
}

await main();
