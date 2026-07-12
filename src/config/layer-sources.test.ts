import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveConfigLayerSources } from "./layer-sources.js";

const parseJson = (content: Uint8Array) => JSON.parse(new TextDecoder().decode(content));
const digest = (content: string) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;

describe("resolveConfigLayerSources", () => {
  it("preserves declared order when source reads finish out of order", async () => {
    const result = await resolveConfigLayerSources(
      [
        { id: "first", source: { delay: 5 }, access: "read-only", contractVersion: 1 },
        { id: "second", source: { delay: 0 }, access: "read-write", contractVersion: 1 },
      ],
      async (source, { layerId }) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, source.delay);
        });
        return {
          content: JSON.stringify({ layerId }),
          sourceIdentity: `source:${layerId}`,
        };
      },
      parseJson,
    );

    expect(result).toMatchObject({
      valid: true,
      layers: [
        { id: "first", config: { layerId: "first" }, access: "read-only" },
        { id: "second", config: { layerId: "second" }, access: "read-write" },
      ],
    });
  });

  it("verifies an expected digest before parsing", async () => {
    const content = JSON.stringify({ gateway: { port: 18789 } });
    const parseSource = vi.fn(parseJson);
    const result = await resolveConfigLayerSources(
      [
        {
          id: "verified",
          source: content,
          access: "read-only",
          contractVersion: 1,
          expectedDigest: digest(content),
        },
      ],
      async (source) => ({ content: source, sourceIdentity: "verified-source" }),
      parseSource,
    );

    expect(result).toMatchObject({
      valid: true,
      layers: [{ sourceIdentity: "verified-source", contentDigest: digest(content) }],
    });
    expect(parseSource).toHaveBeenCalledOnce();
  });

  it("rejects a digest mismatch without parsing", async () => {
    const parseSource = vi.fn(parseJson);
    const result = await resolveConfigLayerSources(
      [
        {
          id: "tampered",
          source: "{}",
          access: "read-only",
          contractVersion: 1,
          expectedDigest: `sha256:${"0".repeat(64)}`,
        },
      ],
      async (source) => ({ content: source, sourceIdentity: "tampered-source" }),
      parseSource,
    );

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerSourceDigestMismatch", layer: "tampered" }],
    });
    expect(parseSource).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs, versions, and digest syntax before source I/O", async () => {
    const resolveSource = vi.fn();
    const result = await resolveConfigLayerSources(
      [
        { id: "", source: 1, access: "read-only", contractVersion: 1 },
        { id: "same", source: 2, access: "read-only", contractVersion: 1 },
        { id: "same", source: 3, access: "read-only", contractVersion: 1 },
        {
          id: "version",
          source: 4,
          access: "read-only",
          contractVersion: 2 as 1,
        },
        {
          id: "digest",
          source: 5,
          access: "read-only",
          contractVersion: 1,
          expectedDigest: "sha256:nope",
        },
      ],
      resolveSource,
      parseJson,
    );

    expect(resolveSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      valid: false,
      findings: [
        { reason: "EmptyLayerId" },
        { reason: "DuplicateLayerId" },
        { reason: "UnsupportedLayerContractVersion" },
        { reason: "InvalidExpectedDigest" },
      ],
    });
  });

  it("attributes source failures without returning partial layers", async () => {
    const result = await resolveConfigLayerSources(
      [
        { id: "good", source: "good", access: "read-only", contractVersion: 1 },
        { id: "bad", source: "bad", access: "read-only", contractVersion: 1 },
      ],
      async (source) => {
        if (source === "bad") {
          throw new Error("source unavailable");
        }
        return { content: "{}", sourceIdentity: source };
      },
      parseJson,
    );

    expect(result).toEqual({
      valid: false,
      findings: [
        {
          reason: "LayerSourceResolutionFailed",
          layer: "bad",
          message: "source unavailable",
        },
      ],
    });
  });

  it("attributes parse failures after successful integrity calculation", async () => {
    const result = await resolveConfigLayerSources(
      [{ id: "bad", source: "{", access: "read-only", contractVersion: 1 }],
      async (content) => ({ content, sourceIdentity: "bad-json" }),
      parseJson,
    );

    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerSourceParseFailed", layer: "bad" }],
    });
  });

  it("keeps access independent from layer name and position", async () => {
    const result = await resolveConfigLayerSources(
      [
        { id: "alpha", source: "{}", access: "read-write", contractVersion: 1 },
        { id: "omega", source: "{}", access: "read-only", contractVersion: 1 },
      ],
      async (content) => ({ content, sourceIdentity: content }),
      parseJson,
    );

    expect(result).toMatchObject({
      valid: true,
      layers: [{ access: "read-write" }, { access: "read-only" }],
    });
  });
});
