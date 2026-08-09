import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  validateProtocolNegotiation,
} from "../../scripts/lobster-protocol-negotiation-evolution.mjs";

const SCRIPT = resolve("scripts/lobster-protocol-negotiation-evolution.mjs");
const FIXTURE = resolve(".lobster/protocol-negotiation-evolution-fixture.json");

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function input(caseIndex = 0): Record<string, unknown> {
  return structuredClone(fixture().cases[caseIndex].input);
}

function owner(): Record<string, unknown> {
  return structuredClone(fixture().owner);
}

describe("lobster.rfn.protocol-negotiation-evolution.v1", () => {
  it("admits only the role-bounded adjacent node trace", () => {
    const result = runFixture().cases[0]!.result;

    expect(result).toMatchObject({
      status: "accepted",
      owner: "openclaw-typescript-gateway",
      compatibilityMode: "legacy-node",
      emittedProtocol: 4,
      authority: "none",
      runtimeMutationAttempted: false,
      releaseDuration: "undeclared",
      rustAdjacentVersionProven: false,
      failures: [],
    });
  });

  it("refuses the same adjacent version for an operator with structured details", () => {
    const result = runFixture().cases[1]!.result;

    expect(result).toMatchObject({
      status: "rejected",
      compatibilityMode: "none",
      emittedProtocol: null,
      failure: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 3,
        clientMaxProtocol: 3,
        expectedProtocol: 4,
        minimumProbeProtocol: 3,
      },
    });
  });

  it("rejects malformed and inverted protocol ranges", () => {
    const malformed = input();
    malformed.minProtocol = "3";
    const inverted = input();
    inverted.minProtocol = 4;
    inverted.maxProtocol = 3;

    expect(validateProtocolNegotiation(malformed, owner()).failures).toContainEqual({
      code: "ProtocolRangeInvalid",
    });
    expect(validateProtocolNegotiation(inverted, owner()).failures).toContainEqual({
      code: "ProtocolRangeInvalid",
    });
  });

  it("does not extend adjacent compatibility to general clients", () => {
    for (const [role, mode] of [
      ["operator", "cli"],
      ["operator", "ui"],
      ["node", "cli"],
    ]) {
      const candidate = input();
      candidate.role = role;
      candidate.mode = mode;
      expect(validateProtocolNegotiation(candidate, owner()).failure?.code).toBe(
        "PROTOCOL_MISMATCH",
      );
    }
  });

  it("accepts current protocol overlap without selecting a lower protocol", () => {
    const candidate = input();
    candidate.minProtocol = 3;
    candidate.maxProtocol = 4;

    expect(validateProtocolNegotiation(candidate, owner())).toMatchObject({
      status: "accepted",
      compatibilityMode: "current",
      emittedProtocol: 4,
    });
  });

  it("rejects future-only clients with structured mismatch details", () => {
    const candidate = input();
    candidate.minProtocol = 5;
    candidate.maxProtocol = 5;

    expect(validateProtocolNegotiation(candidate, owner())).toMatchObject({
      status: "rejected",
      emittedProtocol: null,
      failure: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 5,
        clientMaxProtocol: 5,
        expectedProtocol: 4,
      },
    });
  });

  it("rejects runtime mutation and authority overclaim", () => {
    const candidate = input();
    candidate.runtimeMutationAttempted = true;
    candidate.authority = "gateway";

    expect(validateProtocolNegotiation(candidate, owner()).failures).toEqual(
      expect.arrayContaining([
        { code: "PreAdmissionBoundaryViolated" },
        { code: "AuthorityOverclaimed" },
      ]),
    );
  });

  it("pins N-1 role floors and leaves release duration undeclared", () => {
    const changedOwner = owner();
    changedOwner.minimumNodeProtocol = 2;
    changedOwner.releaseDuration = "two releases";

    expect(validateProtocolNegotiation(input(), changedOwner).failures).toContainEqual({
      code: "OwnerContractMismatch",
    });
  });

  it("does not claim Rust adjacent-version conformance", () => {
    const implementations = runFixture().implementationEvidence;

    expect(implementations).toContainEqual({
      id: "rust-linux-quick-chat",
      language: "rust",
      role: "operator",
      minProtocol: 4,
      maxProtocol: 4,
      evidence: "current-only-source",
    });
    expect(runFixture().cases.every(({ result }) => !result.rustAdjacentVersionProven)).toBe(true);
  });

  it.each([null, [], "invalid"])("fails closed on non-object input %#", (candidate) => {
    expect(validateProtocolNegotiation(candidate, owner()).status).toBe("rejected");
    expect(validateProtocolNegotiation(candidate, owner()).failures).toEqual(
      expect.arrayContaining([
        { code: "InputInvalid" },
        { code: "ProtocolRangeInvalid" },
        { code: "PreAdmissionBoundaryViolated" },
        { code: "AuthorityOverclaimed" },
      ]),
    );
  });

  it("rejects sensitive and unknown fields", () => {
    const candidate = input();
    candidate.token = "not-allowed";

    expect(validateProtocolNegotiation(candidate, owner()).failures).toEqual(
      expect.arrayContaining([{ code: "SensitiveFieldPresent" }, { code: "InputInvalid" }]),
    );
  });

  it("requires exact cross-language implementation evidence", () => {
    const value = fixture();
    value.implementationEvidence[2].minProtocol = 3;
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-protocol-negotiation-"));
    const tempPath = join(tempDir, "fixture.json");
    try {
      writeFileSync(tempPath, JSON.stringify(value), "utf8");
      expect(() => runFixture(tempPath)).toThrow(
        "protocol negotiation fixture envelope is invalid",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails the CLI without success-shaped output for an invalid fixture", () => {
    const result = spawnSync(process.execPath, [SCRIPT, ".lobster/fixtures.json"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("protocol negotiation fixture envelope is invalid");
  });

  it("emits deterministic fixture output", () => {
    const first = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });

    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});
