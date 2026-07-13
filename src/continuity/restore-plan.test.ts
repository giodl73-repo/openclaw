import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContinuityRestorePlanReceipt,
  ContinuityRestorePlanError,
  type CanonicalRestorePlanAsset,
} from "./restore-plan.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function absolute(...segments: string[]): string {
  return path.resolve(path.parse(process.cwd()).root, ...segments);
}

function assets(): CanonicalRestorePlanAsset[] {
  const state = absolute("restore-target", "state");
  return [
    {
      componentId: "config",
      kind: "config",
      restoreOrder: 0,
      canonicalTargetPath: path.join(state, "openclaw.json"),
      canonicalTargetAnchor: absolute("restore-target"),
      materializedSourcePath: absolute("materialized", "openclaw.json"),
      targetKind: "file",
    },
    {
      componentId: "state",
      kind: "state",
      restoreOrder: 1,
      canonicalTargetPath: state,
      canonicalTargetAnchor: absolute("restore-target"),
      materializedSourcePath: absolute("materialized", "state"),
      targetKind: "directory",
    },
    {
      componentId: "workspace-main",
      kind: "workspace",
      restoreOrder: 2,
      canonicalTargetPath: path.join(state, "workspace"),
      canonicalTargetAnchor: absolute("restore-target"),
      materializedSourcePath: absolute("materialized", "workspace"),
      targetKind: "directory",
    },
    {
      componentId: "config-include-external",
      kind: "config-include",
      restoreOrder: 3,
      canonicalTargetPath: absolute("restore-target", "includes", "gateway.json"),
      canonicalTargetAnchor: absolute("restore-target"),
      materializedSourcePath: absolute("materialized", "gateway.json"),
      targetKind: "file",
    },
  ];
}

function build(
  overrides: {
    assets?: CanonicalRestorePlanAsset[];
    authorizedPublicationRoots?: string[];
    runtimeVersion?: string;
  } = {},
) {
  const fixtureAssets = overrides.assets ?? assets();
  return buildContinuityRestorePlanReceipt({
    runtimeVersion: overrides.runtimeVersion ?? "2026.7.12",
    artifact: {
      archiveSha256: HASH_A,
      manifestSha256: HASH_B,
      archiveRoot: "continuity",
    },
    materialization: {
      receiptSha256: HASH_C,
      root: absolute("materialized"),
    },
    assets: fixtureAssets,
    authorizedPublicationRoots: overrides.authorizedPublicationRoots ?? [
      absolute("restore-target", "state"),
      absolute("restore-target", "includes", "gateway.json"),
    ],
  });
}

describe("continuity restore plan receipt", () => {
  it("groups nested assets under an authorized manifest asset root", () => {
    const receipt = build();

    expect(receipt.groups).toHaveLength(2);
    expect(receipt.groups[1]).toMatchObject({
      rootComponentId: "state",
      canonicalTargetPath: absolute("restore-target", "state"),
      targetKind: "directory",
      members: [
        { componentId: "config", targetRelativePath: "openclaw.json" },
        { componentId: "state", targetRelativePath: "." },
        { componentId: "workspace-main", targetRelativePath: "workspace" },
      ],
    });
    expect(receipt.blockers).toEqual([
      { code: "continuity.restore.materialization_content_identity_required" },
      { code: "continuity.restore.launcher_lease_required" },
      { code: "continuity.restore.publication_capability_missing" },
    ]);
    expect(receipt.executionEligible).toBe(false);
  });

  it("never synthesizes a common parent publication root", () => {
    const siblingAssets = assets()
      .slice(0, 2)
      .map((asset, index) => ({
        componentId: `sibling-${index}`,
        kind: asset.kind,
        restoreOrder: asset.restoreOrder,
        canonicalTargetPath: absolute("restore-target", `sibling-${index}`),
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", `sibling-${index}`),
        targetKind: "directory" as const,
      }));

    const receipt = build({
      assets: siblingAssets,
      authorizedPublicationRoots: siblingAssets.map((asset) => asset.canonicalTargetPath),
    });

    expect(receipt.groups.map((group) => group.canonicalTargetPath)).toEqual(
      siblingAssets.map((asset) => asset.canonicalTargetPath).toSorted(),
    );
  });

  it("orders non-ASCII publication roots by stable code units", () => {
    const nonAsciiAssets: CanonicalRestorePlanAsset[] = ["ä", "z"].map((name, index) => ({
      componentId: `sibling-${index}`,
      kind: "workspace",
      restoreOrder: index,
      canonicalTargetPath: absolute("restore-target", name),
      canonicalTargetAnchor: absolute("restore-target"),
      materializedSourcePath: absolute("materialized", name),
      targetKind: "directory",
    }));

    const receipt = build({
      assets: nonAsciiAssets,
      authorizedPublicationRoots: nonAsciiAssets.map((asset) => asset.canonicalTargetPath),
    });

    expect(receipt.groups.map((group) => path.basename(group.canonicalTargetPath))).toEqual([
      "z",
      "ä",
    ]);
  });

  it("rejects missing or extra publication-root authorization", () => {
    expect(() =>
      build({
        authorizedPublicationRoots: [absolute("restore-target", "state")],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContinuityRestorePlanError>>({
        code: "continuity.restore.target_unauthorized",
      }),
    );
  });

  it("rejects source identities outside the verified materialization root", () => {
    const escapedAssets = assets();
    escapedAssets[0] = {
      ...escapedAssets[0]!,
      materializedSourcePath: absolute("foreign", "openclaw.json"),
    };

    expect(() => build({ assets: escapedAssets })).toThrowError(
      expect.objectContaining<Partial<ContinuityRestorePlanError>>({
        code: "continuity.restore.materialization_escape",
      }),
    );
  });

  it("rejects descendants beneath a file publication root", () => {
    const root = absolute("restore-target", "file-root");
    const invalidAssets: CanonicalRestorePlanAsset[] = [
      {
        componentId: "config",
        kind: "config",
        restoreOrder: 0,
        canonicalTargetPath: root,
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", "file-root"),
        targetKind: "file",
      },
      {
        componentId: "workspace",
        kind: "workspace",
        restoreOrder: 1,
        canonicalTargetPath: path.join(root, "workspace"),
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", "workspace"),
        targetKind: "directory",
      },
    ];

    expect(() =>
      build({
        assets: invalidAssets,
        authorizedPublicationRoots: [root],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContinuityRestorePlanError>>({
        code: "continuity.restore.target_overlap",
      }),
    );
  });

  it("rejects descendants beneath a nested file asset", () => {
    const state = absolute("restore-target", "state");
    const invalidAssets: CanonicalRestorePlanAsset[] = [
      {
        componentId: "state",
        kind: "state",
        restoreOrder: 0,
        canonicalTargetPath: state,
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", "state"),
        targetKind: "directory",
      },
      {
        componentId: "config",
        kind: "config",
        restoreOrder: 1,
        canonicalTargetPath: path.join(state, "openclaw.json"),
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", "state", "openclaw.json"),
        targetKind: "file",
      },
      {
        componentId: "workspace",
        kind: "workspace",
        restoreOrder: 2,
        canonicalTargetPath: path.join(state, "openclaw.json", "workspace"),
        canonicalTargetAnchor: absolute("restore-target"),
        materializedSourcePath: absolute("materialized", "state", "workspace"),
        targetKind: "directory",
      },
    ];

    expect(() =>
      build({
        assets: invalidAssets,
        authorizedPublicationRoots: [state],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContinuityRestorePlanError>>({
        code: "continuity.restore.target_overlap",
      }),
    );
  });
});
