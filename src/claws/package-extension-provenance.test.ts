import { describe, expect, it } from "vitest";
import type { ClawPackageRefs } from "../state/openclaw-state-db.generated.js";
import { rowToPackageRef } from "./package-extension-provenance.js";

const row: ClawPackageRefs = {
  agent_id: "assistant",
  claw_name: "@owner/assistant",
  package_kind: "plugin",
  package_source: "clawhub",
  package_ref: "@owner/tools",
  package_version: "1.2.3",
  package_integrity: "sha256:fixture",
  package_status: "complete",
  schema_version: "openclaw.clawPackageRef.v1",
  relationship: "referenced",
  origin: "pre-existing",
  independent_owner: 1,
  installed_at_ms: 1,
  updated_at_ms: 2,
  extension_id: null,
  extension_format: null,
  extension_detected_format: null,
  extension_mapped_json: null,
  extension_unavailable_json: null,
  extension_adapter_identity: null,
};

describe("Claw inventory package row decoding", () => {
  it("decodes generated database rows without losing ownership", () => {
    expect(rowToPackageRef(row)).toMatchObject({
      kind: "plugin",
      source: "clawhub",
      status: "complete",
      relationship: "referenced",
      origin: "pre-existing",
      independentOwner: true,
    });
  });

  it("rejects unsupported lifecycle fields instead of casting them into the contract", () => {
    for (const change of [
      { package_kind: "unknown" },
      { package_source: "unknown" },
      { package_status: "unknown" },
      { relationship: "unknown" },
      { origin: "unknown" },
    ]) {
      expect(() => rowToPackageRef({ ...row, ...change })).toThrow();
    }
  });
});
