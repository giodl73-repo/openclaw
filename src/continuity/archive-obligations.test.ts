import { describe, expect, it } from "vitest";
import type { ContinuityArchiveCaptureEvidence } from "./archive-manifest.js";
import {
  buildContinuityArchiveObligations,
  parseContinuityArchiveObligations,
} from "./archive-obligations.js";

function evidence(): ContinuityArchiveCaptureEvidence {
  return {
    configClassificationComplete: true,
    includeClosureComplete: true,
    sqliteSanitationComplete: true,
    config: {
      includeFileCount: 0,
      secretReferenceCount: 3,
      secretReferencesBySource: { env: 1, file: 2, exec: 0 },
      literalSensitiveValueCount: 0,
    },
    configFileCount: 1,
    workspaceCount: 1,
    oauthExcluded: true,
    legacyTranscriptCount: 0,
    legacyDeliveryQueueCount: 0,
    sqliteSnapshotCount: 1,
    removedAuthProfileStoreRows: 2,
    removedAuthProfileStateRows: 1,
    credentialStoreRows: 0,
    authProfileStateRows: 0,
    omittedPluginDependencyTreeCount: 2,
    copiedFileCount: 4,
    skippedVolatileCount: 0,
  };
}

describe("continuity archive obligations", () => {
  it("builds a closed path-free obligation record from capture evidence", () => {
    const obligations = buildContinuityArchiveObligations(evidence());

    expect(parseContinuityArchiveObligations(obligations)).toEqual(obligations);
    expect(obligations).toMatchObject({
      reconstructed: {
        authProfileRuntimeState: { removedRowCount: 1, readiness: "non-blocking" },
        pluginRuntimeDependencies: { omittedTreeCount: 2, readiness: "owner-required" },
      },
      external: {
        configSecretReferences: {
          referenceCounts: { env: 1, file: 2, exec: 0 },
        },
        authProfileCredentials: {
          removedRowCount: 2,
          credentialRows: 0,
          oauthCaptured: false,
        },
      },
    });
  });

  it.each([
    ["owner", ["reconstructed", "authProfileRuntimeState", "owner"], "other"],
    ["treatment", ["reconstructed", "pluginRuntimeDependencies", "treatment"], "script"],
    ["readiness", ["external", "configSecretReferences", "readiness"], "optional"],
    ["credential rows", ["external", "authProfileCredentials", "credentialRows"], 1],
    ["ID", ["reconstructed", "other"], {}],
  ])("rejects an unknown or success-shaped %s", (_name, keys, replacement) => {
    const obligations = structuredClone(buildContinuityArchiveObligations(evidence())) as Record<
      string,
      unknown
    >;
    let target = obligations;
    for (const key of keys.slice(0, -1)) {
      target = target[key] as Record<string, unknown>;
    }
    target[keys.at(-1)!] = replacement;

    expect(() => parseContinuityArchiveObligations(obligations)).toThrow();
  });
});
