import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ContinuityPublicationAcceptanceReceiptV1,
  ContinuityPublicationIdentityV1,
} from "openclaw/plugin-sdk/types";
import { afterEach, describe, expect, it } from "vitest";
import { LobsterContinuityPublicationProvider } from "./publication-provider.js";

const roots: string[] = [];
const bytes = new TextEncoder().encode("closed continuity archive");

function createIdentity(
  overrides: Partial<ContinuityPublicationIdentityV1> = {},
): ContinuityPublicationIdentityV1 {
  return {
    ownerId: "sha256:owner",
    sourceRuntimeGeneration: "runtime-7",
    handoffId: "handoff-7",
    captureId: "capture-7",
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: "a".repeat(64),
    archiveSize: bytes.byteLength,
    ...overrides,
  };
}

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".lobster-publication-test-"));
  roots.push(root);
  return root;
}

async function* chunkedContent(content = bytes): AsyncIterable<Uint8Array> {
  yield content.subarray(0, 3);
  yield content.subarray(3, 11);
  yield content.subarray(11);
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("LobsterContinuityPublicationProvider", () => {
  it("streams a publication and retrieves it through a fresh provider instance", async () => {
    const root = await createRoot();
    const identity = createIdentity();
    const provider = new LobsterContinuityPublicationProvider(root, "provider-7");

    const acceptance = await provider.publish({
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const receipt: ContinuityPublicationAcceptanceReceiptV1 = {
      ...acceptance,
      publicationBindingId: provider.id,
      publicationBindingGeneration: provider.generation,
      hostBundleGeneration: "bundle-7",
    };
    const freshProvider = new LobsterContinuityPublicationProvider(root, "provider-7");
    const retrieval = await freshProvider.retrieve({
      receipt,
      signal: new AbortController().signal,
    });

    expect(await collect(retrieval.content)).toEqual(Buffer.from(bytes));
    expect(retrieval.identity).toStrictEqual(identity);
  });

  it("returns the original acceptance for exact replay", async () => {
    const root = await createRoot();
    const provider = new LobsterContinuityPublicationProvider(root, "provider-7");
    const identity = createIdentity();

    const first = await provider.publish({
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const replay = await new LobsterContinuityPublicationProvider(root, "provider-7").publish({
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });

    expect(replay).toStrictEqual(first);
  });

  it("rejects changed content for the same logical handoff", async () => {
    const root = await createRoot();
    const provider = new LobsterContinuityPublicationProvider(root, "provider-7");
    const identity = createIdentity();
    await provider.publish({
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const changed = new TextEncoder().encode("different archive");

    await expect(
      new LobsterContinuityPublicationProvider(root, "provider-7").publish({
        identity: createIdentity({
          archiveSha256: createHash("sha256").update(changed).digest("hex"),
          archiveSize: changed.byteLength,
        }),
        content: chunkedContent(changed),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("verifies size and digest before accepting a new publication", async () => {
    const root = await createRoot();
    const provider = new LobsterContinuityPublicationProvider(root, "provider-7");

    await expect(
      provider.publish({
        identity: createIdentity(),
        content: chunkedContent(new TextEncoder().encode("wrong")),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("quarantines corrupt metadata for an existing logical publication", async () => {
    const root = await createRoot();
    const provider = new LobsterContinuityPublicationProvider(root, "provider-7");
    const identity = createIdentity();
    await provider.publish({
      identity,
      content: chunkedContent(),
      signal: new AbortController().signal,
    });
    const [ownerDirectory] = await fs.readdir(path.join(root, "objects"));
    const [publicationDirectory] = await fs.readdir(
      path.join(root, "objects", ownerDirectory ?? ""),
    );
    await fs.writeFile(
      path.join(root, "objects", ownerDirectory ?? "", publicationDirectory ?? "", "metadata.json"),
      "{",
    );

    await expect(
      new LobsterContinuityPublicationProvider(root, "provider-7").publish({
        identity,
        content: chunkedContent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
