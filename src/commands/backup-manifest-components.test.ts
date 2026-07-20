import { describe, expect, it } from "vitest";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  buildBackupManifestComponents,
  validateBackupManifestComponents,
} from "./backup-manifest-components.js";

function workspaceId(sourcePath: string): string {
  return `workspace-${sha256Hex(sourcePath).slice(0, 16)}`;
}

describe("backup manifest components", () => {
  it("assigns path-free stable ids and deterministic restore order", () => {
    expect(
      buildBackupManifestComponents([
        { kind: "state", sourcePath: "/state" },
        { kind: "config", sourcePath: "/config" },
        { kind: "workspace", sourcePath: "/workspace/a" },
        { kind: "workspace", sourcePath: "/workspace/b" },
      ]),
    ).toEqual([
      { id: "state", restoreOrder: 1, dependsOn: [] },
      { id: "config", restoreOrder: 0, dependsOn: [] },
      { id: workspaceId("/workspace/a"), restoreOrder: 2, dependsOn: [] },
      { id: workspaceId("/workspace/b"), restoreOrder: 3, dependsOn: [] },
    ]);
  });

  it("keeps a workspace id stable when sibling workspaces are added", () => {
    const original = buildBackupManifestComponents([
      { kind: "workspace", sourcePath: "/workspace/a" },
    ]);
    const withSibling = buildBackupManifestComponents([
      { kind: "workspace", sourcePath: "/workspace/b" },
      { kind: "workspace", sourcePath: "/workspace/a" },
    ]);

    expect(original[0]?.id).toBe(workspaceId("/workspace/a"));
    expect(withSibling[1]?.id).toBe(original[0]?.id);
  });

  it("accepts legacy manifests without component metadata", () => {
    expect(validateBackupManifestComponents([{}, {}])).toEqual([]);
  });

  it("accepts an ordered dependency graph", () => {
    expect(
      validateBackupManifestComponents([
        { component: { id: "config", restoreOrder: 0, dependsOn: [] } },
        { component: { id: "state", restoreOrder: 1, dependsOn: ["config"] } },
      ]),
    ).toEqual([
      { id: "config", restoreOrder: 0, dependsOn: [] },
      { id: "state", restoreOrder: 1, dependsOn: ["config"] },
    ]);
  });

  it.each([
    {
      name: "partial metadata",
      assets: [{ component: { id: "config", restoreOrder: 0, dependsOn: [] } }, {}],
      error: /every asset or none/i,
    },
    {
      name: "duplicate ids",
      assets: [
        { component: { id: "state", restoreOrder: 0, dependsOn: [] } },
        { component: { id: "state", restoreOrder: 1, dependsOn: [] } },
      ],
      error: /duplicate component id/i,
    },
    {
      name: "missing dependency",
      assets: [{ component: { id: "state", restoreOrder: 0, dependsOn: ["config"] } }],
      error: /dependency is missing/i,
    },
    {
      name: "forward dependency",
      assets: [
        { component: { id: "state", restoreOrder: 0, dependsOn: ["config"] } },
        { component: { id: "config", restoreOrder: 1, dependsOn: [] } },
      ],
      error: /dependency must restore first/i,
    },
    {
      name: "non-contiguous order",
      assets: [{ component: { id: "state", restoreOrder: 1, dependsOn: [] } }],
      error: /contiguous from zero/i,
    },
  ])("rejects $name", ({ assets, error }) => {
    expect(() => validateBackupManifestComponents(assets)).toThrow(error);
  });
});
