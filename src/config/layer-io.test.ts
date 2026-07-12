import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagedConfigIO,
  getManagedConfigReadiness,
  resetManagedConfigIOForTest,
} from "./layer-io.js";
import { identifyAuthorityChain } from "./layer-management.js";
import { resolveConfigLayerSources, type ConfigLayerDescriptor } from "./layer-sources.js";

const documents: Record<string, string> = {
  managed: JSON.stringify({ gateway: { mode: "local" } }),
  operator: JSON.stringify({ gateway: { port: 19001 } }),
};
const descriptors: ConfigLayerDescriptor<string>[] = [
  { id: "managed", source: "managed", access: "read-only", contractVersion: 1 },
  { id: "operator", source: "operator", access: "read-write", contractVersion: 1 },
];
const parseSource = (content: Uint8Array) => JSON.parse(new TextDecoder().decode(content));
const resolveSource = async (source: string) => ({
  content: documents[source],
  sourceIdentity: "source:" + source,
});

beforeEach(() => {
  resetManagedConfigIOForTest();
  documents.managed = JSON.stringify({ gateway: { mode: "local" } });
  documents.operator = JSON.stringify({ gateway: { port: 19001 } });
});

describe("managed config I/O facade", () => {
  it("is invisible until explicitly constructed", () => {
    expect(getManagedConfigReadiness()).toBeNull();
  });

  it("enforces one process-global publisher and readiness journal", () => {
    const params = {
      descriptors,
      resolveSource,
      parseSource,
      persist: vi.fn(),
      publish: vi.fn(),
      configIO: { observe: false },
    };
    createManagedConfigIO(params);
    expect(() => createManagedConfigIO(params)).toThrow(
      "managed configuration I/O is already registered for this process",
    );
  });

  it("activates one candidate and registers ready state", async () => {
    const publish = vi.fn();
    const io = createManagedConfigIO({
      descriptors,
      resolveSource,
      parseSource,
      persist: vi.fn(),
      publish,
      configIO: { observe: false },
    });

    await expect(io.activate()).resolves.toMatchObject({ valid: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getManagedConfigReadiness()).toMatchObject({
      ready: true,
      activeGeneration: 1,
      attemptGeneration: 1,
    });
  });

  it("rechecks the complete chain immediately before persistence", async () => {
    const current = await resolveConfigLayerSources(descriptors, resolveSource, parseSource);
    if (!current.valid) {
      throw new Error("fixture did not resolve");
    }
    const expectedTargetDigest = current.layers[1].contentDigest;
    const expectedAuthorityChainIdentity = identifyAuthorityChain(current.layers);
    const persist = vi.fn();
    let resolution = 0;
    const racingResolver = async (source: string) => {
      resolution += 1;
      if (resolution > descriptors.length && source === "managed") {
        return {
          content: JSON.stringify({ gateway: { mode: "remote" } }),
          sourceIdentity: "source:managed",
        };
      }
      return await resolveSource(source);
    };
    const io = createManagedConfigIO({
      descriptors,
      resolveSource: racingResolver,
      parseSource,
      persist,
      publish: vi.fn(),
      configIO: { observe: false },
    });

    const result = await io.write({
      targetLayerId: "operator",
      proposedContent: JSON.stringify({ gateway: { port: 19003 } }),
      expectedTargetDigest,
      expectedAuthorityChainIdentity,
    });
    expect(result).toMatchObject({
      valid: false,
      findings: [{ reason: "LayerPersistenceFailed" }],
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps readiness healthy after a routine rejected write", async () => {
    const io = createManagedConfigIO({
      descriptors,
      resolveSource,
      parseSource,
      persist: vi.fn(),
      publish: vi.fn(),
      configIO: { observe: false },
    });
    const activated = await io.activate();
    if (!activated.valid) {
      throw new Error("fixture did not activate");
    }
    const current = await resolveConfigLayerSources(descriptors, resolveSource, parseSource);
    if (!current.valid) {
      throw new Error("fixture did not resolve");
    }
    await io.write({
      targetLayerId: "managed",
      proposedContent: documents.managed,
      expectedTargetDigest: current.layers[0].contentDigest,
      expectedAuthorityChainIdentity: identifyAuthorityChain(current.layers),
    });
    expect(getManagedConfigReadiness()).toMatchObject({
      ready: true,
      activeGeneration: 1,
      attemptGeneration: 2,
    });
  });

  it("uses layer identity when multiple descriptors share one source", async () => {
    const sharedDescriptors: ConfigLayerDescriptor<string>[] = [
      { id: "first", source: "shared", access: "read-only", contractVersion: 1 },
      { id: "second", source: "shared", access: "read-write", contractVersion: 1 },
    ];
    const sharedResolver = async () => ({
      content: JSON.stringify({ gateway: { mode: "local" } }),
      sourceIdentity: "source:shared",
    });
    const current = await resolveConfigLayerSources(sharedDescriptors, sharedResolver, parseSource);
    if (!current.valid) {
      throw new Error("fixture did not resolve");
    }
    const persist = vi.fn();
    const io = createManagedConfigIO({
      descriptors: sharedDescriptors,
      resolveSource: sharedResolver,
      parseSource,
      persist,
      publish: vi.fn(),
      configIO: { observe: false },
    });
    await io.write({
      targetLayerId: "second",
      proposedContent: JSON.stringify({ gateway: { mode: "local" } }),
      expectedTargetDigest: current.layers[1].contentDigest,
      expectedAuthorityChainIdentity: identifyAuthorityChain(current.layers),
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ targetLayerId: "second" }));
  });
});
