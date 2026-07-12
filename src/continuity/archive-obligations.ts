import { isRecord } from "../utils.js";
import type { ContinuityArchiveCaptureEvidence } from "./archive-manifest.js";

export type ContinuityArchiveObligations = {
  schemaVersion: 1;
  reconstructed: {
    authProfileRuntimeState: {
      owner: "auth-profiles";
      treatment: "safe-empty-default";
      removedRowCount: number;
      readiness: "non-blocking";
    };
    pluginRuntimeDependencies: {
      owner: "plugins";
      treatment: "owner-reinstall";
      omittedTreeCount: number;
      readiness: "owner-required";
    };
  };
  external: {
    configSecretReferences: {
      owner: "secrets";
      referenceCounts: {
        env: number;
        file: number;
        exec: number;
      };
      readiness: "owner-required";
    };
    authProfileCredentials: {
      owner: "auth-profiles";
      removedRowCount: number;
      credentialRows: 0;
      oauthCaptured: false;
      readiness: "owner-required";
    };
  };
  ephemeral: {
    runtimeTransients: {
      owner: "runtime";
      treatment: "normal-startup";
      readiness: "owner-owned";
    };
  };
};

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Continuity obligation ${key} must be a non-negative safe integer.`);
  }
  return value;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Continuity obligation ${key} must be an object.`);
  }
  return value;
}

function expectLiteral(
  record: Record<string, unknown>,
  key: string,
  expected: string | number | boolean,
): void {
  if (record[key] !== expected) {
    throw new Error(`Continuity obligation ${key} must be ${JSON.stringify(expected)}.`);
  }
}

function expectExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const unexpected = Object.keys(record).find((key) => !expected.includes(key));
  if (unexpected || Object.keys(record).length !== expected.length) {
    throw new Error(
      `Continuity obligation contains an unknown or missing field: ${unexpected ?? "unknown"}.`,
    );
  }
}

export function buildContinuityArchiveObligations(
  evidence: ContinuityArchiveCaptureEvidence,
): ContinuityArchiveObligations {
  return {
    schemaVersion: 1,
    reconstructed: {
      authProfileRuntimeState: {
        owner: "auth-profiles",
        treatment: "safe-empty-default",
        removedRowCount: evidence.removedAuthProfileStateRows,
        readiness: "non-blocking",
      },
      pluginRuntimeDependencies: {
        owner: "plugins",
        treatment: "owner-reinstall",
        omittedTreeCount: evidence.omittedPluginDependencyTreeCount,
        readiness: "owner-required",
      },
    },
    external: {
      configSecretReferences: {
        owner: "secrets",
        referenceCounts: { ...evidence.config.secretReferencesBySource },
        readiness: "owner-required",
      },
      authProfileCredentials: {
        owner: "auth-profiles",
        removedRowCount: evidence.removedAuthProfileStoreRows,
        credentialRows: 0,
        oauthCaptured: false,
        readiness: "owner-required",
      },
    },
    ephemeral: {
      runtimeTransients: {
        owner: "runtime",
        treatment: "normal-startup",
        readiness: "owner-owned",
      },
    },
  };
}

export function parseContinuityArchiveObligations(value: unknown): ContinuityArchiveObligations {
  if (!isRecord(value)) {
    throw new Error("Continuity manifest obligations must be an object.");
  }
  expectExactKeys(value, ["schemaVersion", "reconstructed", "external", "ephemeral"]);
  expectLiteral(value, "schemaVersion", 1);

  const reconstructed = readRecord(value, "reconstructed");
  expectExactKeys(reconstructed, ["authProfileRuntimeState", "pluginRuntimeDependencies"]);
  const authProfileRuntimeState = readRecord(reconstructed, "authProfileRuntimeState");
  expectExactKeys(authProfileRuntimeState, ["owner", "treatment", "removedRowCount", "readiness"]);
  expectLiteral(authProfileRuntimeState, "owner", "auth-profiles");
  expectLiteral(authProfileRuntimeState, "treatment", "safe-empty-default");
  expectLiteral(authProfileRuntimeState, "readiness", "non-blocking");
  const pluginRuntimeDependencies = readRecord(reconstructed, "pluginRuntimeDependencies");
  expectExactKeys(pluginRuntimeDependencies, [
    "owner",
    "treatment",
    "omittedTreeCount",
    "readiness",
  ]);
  expectLiteral(pluginRuntimeDependencies, "owner", "plugins");
  expectLiteral(pluginRuntimeDependencies, "treatment", "owner-reinstall");
  expectLiteral(pluginRuntimeDependencies, "readiness", "owner-required");

  const external = readRecord(value, "external");
  expectExactKeys(external, ["configSecretReferences", "authProfileCredentials"]);
  const configSecretReferences = readRecord(external, "configSecretReferences");
  expectExactKeys(configSecretReferences, ["owner", "referenceCounts", "readiness"]);
  expectLiteral(configSecretReferences, "owner", "secrets");
  expectLiteral(configSecretReferences, "readiness", "owner-required");
  const referenceCounts = readRecord(configSecretReferences, "referenceCounts");
  expectExactKeys(referenceCounts, ["env", "file", "exec"]);
  const authProfileCredentials = readRecord(external, "authProfileCredentials");
  expectExactKeys(authProfileCredentials, [
    "owner",
    "removedRowCount",
    "credentialRows",
    "oauthCaptured",
    "readiness",
  ]);
  expectLiteral(authProfileCredentials, "owner", "auth-profiles");
  expectLiteral(authProfileCredentials, "credentialRows", 0);
  expectLiteral(authProfileCredentials, "oauthCaptured", false);
  expectLiteral(authProfileCredentials, "readiness", "owner-required");

  const ephemeral = readRecord(value, "ephemeral");
  expectExactKeys(ephemeral, ["runtimeTransients"]);
  const runtimeTransients = readRecord(ephemeral, "runtimeTransients");
  expectExactKeys(runtimeTransients, ["owner", "treatment", "readiness"]);
  expectLiteral(runtimeTransients, "owner", "runtime");
  expectLiteral(runtimeTransients, "treatment", "normal-startup");
  expectLiteral(runtimeTransients, "readiness", "owner-owned");

  return {
    schemaVersion: 1,
    reconstructed: {
      authProfileRuntimeState: {
        owner: "auth-profiles",
        treatment: "safe-empty-default",
        removedRowCount: readNonNegativeInteger(authProfileRuntimeState, "removedRowCount"),
        readiness: "non-blocking",
      },
      pluginRuntimeDependencies: {
        owner: "plugins",
        treatment: "owner-reinstall",
        omittedTreeCount: readNonNegativeInteger(pluginRuntimeDependencies, "omittedTreeCount"),
        readiness: "owner-required",
      },
    },
    external: {
      configSecretReferences: {
        owner: "secrets",
        referenceCounts: {
          env: readNonNegativeInteger(referenceCounts, "env"),
          file: readNonNegativeInteger(referenceCounts, "file"),
          exec: readNonNegativeInteger(referenceCounts, "exec"),
        },
        readiness: "owner-required",
      },
      authProfileCredentials: {
        owner: "auth-profiles",
        removedRowCount: readNonNegativeInteger(authProfileCredentials, "removedRowCount"),
        credentialRows: 0,
        oauthCaptured: false,
        readiness: "owner-required",
      },
    },
    ephemeral: {
      runtimeTransients: {
        owner: "runtime",
        treatment: "normal-startup",
        readiness: "owner-owned",
      },
    },
  };
}
