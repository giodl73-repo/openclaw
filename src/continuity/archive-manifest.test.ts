import { describe, expect, it } from "vitest";
import {
  buildContinuityArchiveCapture,
  parseContinuityArchiveCapture,
  type ContinuityArchiveCaptureEvidence,
} from "./archive-manifest.js";

function validEvidence(): ContinuityArchiveCaptureEvidence {
  return {
    configClassificationComplete: true,
    includeClosureComplete: true,
    sqliteSanitationComplete: true,
    config: {
      includeFileCount: 0,
      secretReferenceCount: 1,
      secretReferencesBySource: { env: 1, file: 0, exec: 0 },
      literalSensitiveValueCount: 0,
    },
    configFileCount: 1,
    workspaceCount: 1,
    oauthExcluded: true,
    legacyTranscriptCount: 0,
    legacyDeliveryQueueCount: 0,
    sqliteSnapshotCount: 1,
    removedAuthProfileStoreRows: 1,
    removedAuthProfileStateRows: 1,
    credentialStoreRows: 0,
    authProfileStateRows: 0,
    omittedPluginDependencyTreeCount: 0,
    copiedFileCount: 4,
    skippedVolatileCount: 0,
  };
}

describe("continuity archive capture manifest", () => {
  it("accepts complete fail-closed evidence", () => {
    const capture = buildContinuityArchiveCapture(validEvidence());
    expect(parseContinuityArchiveCapture(capture)).toEqual(capture);
  });

  it.each([
    {
      name: "credential rows",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.credentialStoreRows = 1;
      },
    },
    {
      name: "literal sensitive values",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.config as Record<string, unknown>).literalSensitiveValueCount = 1;
      },
    },
    {
      name: "incomplete config classification",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.configClassificationComplete = false;
      },
    },
    {
      name: "inconsistent include closure",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.configFileCount = 2;
      },
    },
  ])("rejects success-shaped $name evidence", ({ mutate }) => {
    const capture = structuredClone(buildContinuityArchiveCapture(validEvidence()));
    mutate(capture.evidence);
    expect(() => parseContinuityArchiveCapture(capture)).toThrow();
  });
});
