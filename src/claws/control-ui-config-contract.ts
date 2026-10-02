import type { ConfigAuditRecord } from "../config/io.audit.js";
import type {
  ConfigHealthEntryChanges,
  ConfigHealthSnapshot,
} from "../config/io.health-state.types.js";

export type ClawConfigLocation = { env: NodeJS.ProcessEnv; homedir: string };
export type ClawConfigRequest = ClawConfigOperation & { rollbackMetadata?: true };

type ClawConfigOperation =
  | { operation: "capture"; location: ClawConfigLocation; configPath: string; guard: number }
  | { operation: "continue" | "current" | "dispose"; observation: number }
  | { operation: "read"; observation: number; artifactPreserving: boolean }
  | {
      operation: "update" | "updateAfterFileCommit";
      observation: number;
      changes: ConfigHealthEntryChanges;
      previous: ConfigHealthSnapshot;
    }
  | { operation: "readHealth"; location: ClawConfigLocation; artifactPreserving: boolean }
  | { operation: "supersede"; location: ClawConfigLocation; configPath: string }
  | {
      operation: "patchHealth";
      location: ClawConfigLocation;
      configPath: string;
      changes: ConfigHealthEntryChanges;
    }
  | { operation: "audit"; location: ClawConfigLocation; record: ConfigAuditRecord; guard: number };

export type ClawConfigGuardRequest = { guard: number };
