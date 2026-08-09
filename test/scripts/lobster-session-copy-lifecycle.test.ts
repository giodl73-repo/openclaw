import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateSessionCopyLifecycleFixture } from "../../scripts/lobster-session-copy-lifecycle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, ".lobster/session-copy-lifecycle-fixture.json"), "utf8"),
  ) as Record<string, unknown>;
}

function operations(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return input.operations as Array<Record<string, unknown>>;
}

function codes(input: unknown): string[] {
  return validateSessionCopyLifecycleFixture(input).failures.map((failure) => failure.code);
}

describe("session copy lifecycle evidence", () => {
  it("accepts separate export, partial archive deletion, purge, and generation fence", async () => {
    expect(validateSessionCopyLifecycleFixture(await fixture())).toMatchObject({
      authority: "none",
      status: "pass",
      exportCompleteCount: 1,
      deleteCompleteCount: 1,
      deletePartialCount: 1,
      blockedCount: 1,
      unknownCount: 0,
      failures: [],
    });
  });

  it("rejects unsupported fields", async () => {
    const input = await fixture();
    input.copyDatabase = true;
    expect(codes(input)).toContain("ContractMismatch");
  });

  it("rejects sensitive transcript content", async () => {
    const input = await fixture();
    operations(input)[0]!.content = "raw transcript";
    expect(codes(input)).toContain("SensitivePayloadPresent");
  });

  it("rejects wrong reference classes", async () => {
    const input = await fixture();
    const inventory = input.inventory as Record<string, unknown[]>;
    inventory.sessionRefs![0] =
      "copy-sha256:1111111111111111111111111111111111111111111111111111111111111111";
    expect(codes(input)).toContain("InventoryMismatch");
  });

  it("rejects stale export generation", async () => {
    const input = await fixture();
    const target = operations(input)[0]!.target as Record<string, unknown>;
    target.expectedGenerationRef =
      "generation-sha256:5555555555555555555555555555555555555555555555555555555555555555";
    expect(codes(input)).toContain("GenerationFenceInvalid");
  });

  it("rejects deletion of a different generation than the exported copy", async () => {
    const input = await fixture();
    const target = operations(input)[1]!.target as Record<string, unknown>;
    target.sessionRef =
      "session-sha256:2222222222222222222222222222222222222222222222222222222222222222";
    expect(codes(input)).toContain("GenerationFenceInvalid");
  });

  it("rejects reordered export and deletion operations", async () => {
    const input = await fixture();
    const lifecycleOperations = operations(input);
    [lifecycleOperations[0], lifecycleOperations[1]] = [
      lifecycleOperations[1]!,
      lifecycleOperations[0]!,
    ];
    expect(codes(input)).toContain("GenerationFenceInvalid");
  });

  it("rejects export without delegated-backend omission", async () => {
    const input = await fixture();
    const evidence = operations(input)[0]!.export as Record<string, unknown>;
    evidence.omittedClasses = [];
    expect(codes(input)).toContain("ExportEvidenceInvalid");
  });

  it("rejects export without disclosure expiry", async () => {
    const input = await fixture();
    const evidence = operations(input)[0]!.export as Record<string, unknown>;
    evidence.expiresAt = "not-a-date";
    expect(codes(input)).toContain("ExportEvidenceInvalid");
  });

  it("rejects ordinary deletion without archive creation", async () => {
    const input = await fixture();
    const mutation = operations(input)[1]!.mutation as Record<string, unknown>;
    mutation.archiveCreated = false;
    expect(codes(input)).toContain("MutationBoundaryInvalid");
  });

  it("rejects ordinary deletion reported as complete purge", async () => {
    const input = await fixture();
    operations(input)[1]!.result = "complete";
    expect(codes(input)).toContain("PurgeOverclaimed");
  });

  it("rejects hidden external provider settlement", async () => {
    const input = await fixture();
    const settlements = operations(input)[1]!.settlements as Array<Record<string, unknown>>;
    settlements.pop();
    expect(codes(input)).toContain("SettlementInvalid");
  });

  it("rejects QMD deferred cleanup hidden as immediate completion", async () => {
    const input = await fixture();
    const settlements = operations(input)[1]!.settlements as Array<Record<string, unknown>>;
    settlements[4]!.initialResult = "complete";
    expect(codes(input)).toContain("SettlementInvalid");
  });

  it("rejects purge with a retained archive", async () => {
    const input = await fixture();
    const mutation = operations(input)[2]!.mutation as Record<string, unknown>;
    mutation.archiveCreated = true;
    expect(codes(input)).toContain("MutationBoundaryInvalid");
  });

  it("rejects purge before restart reconciliation", async () => {
    const input = await fixture();
    operations(input)[2]!.restartReconciled = false;
    expect(codes(input)).toContain("PurgeOverclaimed");
  });

  it("rejects stale-generation mutation", async () => {
    const input = await fixture();
    const mutation = operations(input)[3]!.mutation as Record<string, unknown>;
    mutation.registry = "removed";
    expect(codes(input)).toContain("GenerationFenceInvalid");
  });

  it("rejects missing operation inventory", async () => {
    const input = await fixture();
    operations(input).pop();
    expect(codes(input)).toContain("InventoryMismatch");
  });

  it("rejects copy inventory drift", async () => {
    const input = await fixture();
    const inventory = input.inventory as Record<string, unknown[]>;
    inventory.copyRefs!.push(
      "copy-sha256:1212121212121212121212121212121212121212121212121212121212121212",
    );
    expect(codes(input)).toContain("InventoryMismatch");
  });

  it("rejects unused generation inventory", async () => {
    const input = await fixture();
    const inventory = input.inventory as Record<string, unknown[]>;
    inventory.generationRefs!.push(
      "generation-sha256:1212121212121212121212121212121212121212121212121212121212121212",
    );
    expect(codes(input)).toContain("InventoryMismatch");
  });

  it("rejects final-state count drift", async () => {
    const input = await fixture();
    const finalState = input.finalState as Record<string, unknown>;
    finalState.blockedCount = 0;
    expect(codes(input)).toContain("FinalStateMismatch");
  });

  it("rejects aggregate assurance without the bounded trace", async () => {
    const input = await fixture();
    const finalState = input.finalState as Record<string, unknown>;
    finalState.aggregateAssurance = "partial";
    expect(codes(input)).toContain("AssuranceOverclaimed");
  });
});
