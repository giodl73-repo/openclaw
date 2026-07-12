import { describe, expect, it, vi } from "vitest";
import {
  createLayerGenerationJournal,
  identifyAuthorityChain,
  writeConfigLayer,
} from "./layer-management.js";
import type { ConfigLayerDescriptor } from "./layer-sources.js";

const parseJson = (content: Uint8Array) => JSON.parse(new TextDecoder().decode(content));
const documents: Record<string, string> = {
  managed: JSON.stringify({ gateway: { mode: "local" } }),
  operator: JSON.stringify({ gateway: { port: 19001 } }),
};
const descriptors: ConfigLayerDescriptor<string>[] = [
  { id: "managed", source: "managed", access: "read-only", contractVersion: 1 },
  { id: "operator", source: "operator", access: "read-write", contractVersion: 1 },
];
const resolveSource = async (source: string) => ({
  content: documents[source],
  sourceIdentity: `source:${source}`,
});

async function currentIdentities() {
  const { resolveConfigLayerSources } = await import("./layer-sources.js");
  const resolved = await resolveConfigLayerSources(descriptors, resolveSource, parseJson);
  if (!resolved.valid) {
    throw new Error("fixture did not resolve");
  }
  return {
    targetDigest: resolved.layers[1].contentDigest,
    chainIdentity: identifyAuthorityChain(resolved.layers),
  };
}

describe("managed layer writes", () => {
  it("preflights, persists, then publishes a writable target", async () => {
    const identities = await currentIdentities();
    const calls: string[] = [];
    const result = await writeConfigLayer({
      descriptors,
      targetLayerId: "operator",
      proposedContent: JSON.stringify({ gateway: { port: 19002 } }),
      expectedTargetDigest: identities.targetDigest,
      expectedAuthorityChainIdentity: identities.chainIdentity,
      resolveSource,
      parseSource: parseJson,
      persist: async () => void calls.push("persist"),
      publish: async () => void calls.push("publish"),
    });
    expect(result.valid).toBe(true);
    expect(calls).toEqual(["persist", "publish"]);
    expect(result).not.toMatchObject({ authorityChainIdentity: identities.chainIdentity });
  });

  it("rejects a read-only target without persistence", async () => {
    const identities = await currentIdentities();
    const persist = vi.fn();
    const result = await writeConfigLayer({
      descriptors,
      targetLayerId: "managed",
      proposedContent: documents.managed,
      expectedTargetDigest: "unused",
      expectedAuthorityChainIdentity: identities.chainIdentity,
      resolveSource,
      parseSource: parseJson,
      persist,
      publish: vi.fn(),
    });
    expect(result).toMatchObject({ valid: false, findings: [{ reason: "ReadOnlyLayer" }] });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects stale target and chain identities independently", async () => {
    const identities = await currentIdentities();
    const common = {
      descriptors,
      targetLayerId: "operator",
      proposedContent: documents.operator,
      resolveSource,
      parseSource: parseJson,
      persist: vi.fn(),
      publish: vi.fn(),
    };
    await expect(
      writeConfigLayer({
        ...common,
        expectedTargetDigest: "sha256:stale",
        expectedAuthorityChainIdentity: identities.chainIdentity,
      }),
    ).resolves.toMatchObject({ valid: false, findings: [{ reason: "StaleTargetGeneration" }] });
    await expect(
      writeConfigLayer({
        ...common,
        expectedTargetDigest: identities.targetDigest,
        expectedAuthorityChainIdentity: "sha256:stale",
      }),
    ).resolves.toMatchObject({ valid: false, findings: [{ reason: "StaleAuthorityChain" }] });
  });

  it("rejects authority conflicts before persistence", async () => {
    const identities = await currentIdentities();
    const persist = vi.fn();
    const result = await writeConfigLayer({
      descriptors,
      targetLayerId: "operator",
      proposedContent: JSON.stringify({ gateway: { mode: "remote" } }),
      expectedTargetDigest: identities.targetDigest,
      expectedAuthorityChainIdentity: identities.chainIdentity,
      resolveSource,
      parseSource: parseJson,
      persist,
      publish: vi.fn(),
    });
    expect(result.valid).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not publish after persistence failure", async () => {
    const identities = await currentIdentities();
    const publish = vi.fn();
    const result = await writeConfigLayer({
      descriptors,
      targetLayerId: "operator",
      proposedContent: documents.operator,
      expectedTargetDigest: identities.targetDigest,
      expectedAuthorityChainIdentity: identities.chainIdentity,
      resolveSource,
      parseSource: parseJson,
      persist: async () => {
        throw new Error("compare-and-swap failed");
      },
      publish,
    });
    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerPersistenceFailed" }],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports persisted identity when activation fails", async () => {
    const identities = await currentIdentities();
    const result = await writeConfigLayer({
      descriptors,
      targetLayerId: "operator",
      proposedContent: JSON.stringify({ gateway: { port: 19002 } }),
      expectedTargetDigest: identities.targetDigest,
      expectedAuthorityChainIdentity: identities.chainIdentity,
      resolveSource,
      parseSource: parseJson,
      persist: vi.fn(),
      publish: async () => {
        throw new Error("publisher unavailable");
      },
    });
    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerPersistedButActivationFailed" }],
      persisted: {
        targetDigest: expect.stringMatching(/^sha256:/),
        authorityChainIdentity: expect.stringMatching(/^sha256:/),
      },
    });
  });
});

describe("managed layer generation journal", () => {
  it("retains the previous active generation while a rejected candidate fails readiness", () => {
    const journal = createLayerGenerationJournal(() => new Date("2026-07-11T00:00:00Z"));
    journal.recordActivated({
      sourceConfig: {},
      runtimeConfig: {},
      provenance: [],
      layers: [
        {
          id: "operator",
          access: "read-write",
          sourceIdentity: "source:operator",
          contentDigest: "sha256:redacted",
        },
      ],
      advisories: [{ reason: "NoDeclaredValues", layer: "operator" }],
    });
    journal.recordRejected([
      {
        reason: "StaleAuthorityChain",
        layer: "operator",
        expected: "a",
        actual: "b",
        message: "retry",
      },
    ]);
    expect(journal.readiness()).toEqual({
      ready: false,
      reason: "managed-config-candidate-rejected",
      activeGeneration: 1,
      attemptGeneration: 2,
    });
    expect(journal.inspect()).toMatchObject({
      activeGeneration: 1,
      attemptGeneration: 2,
      findings: [{ reason: "StaleAuthorityChain", layer: "operator" }],
      advisories: [{ reason: "NoDeclaredValues", layer: "operator" }],
    });
    expect(journal.inspect()).not.toHaveProperty("sourceConfig");
    expect(journal.inspect()).not.toHaveProperty("runtimeConfig");
  });
});
