import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

type persistClawInstallRecord = typeof import("./provenance.js").persistClawInstallRecord;
type updateClawInstallRecord = typeof import("./provenance.js").updateClawInstallRecord;
type updateClawInstallRecordStatus = typeof import("./provenance.js").updateClawInstallRecordStatus;
type deleteClawInstallRecord = typeof import("./provenance.js").deleteClawInstallRecord;
type persistClawPackageRef = typeof import("./provenance.js").persistClawPackageRef;
type updateClawPackageRefStatus = typeof import("./provenance.js").updateClawPackageRefStatus;
type persistWorkspaceFile = typeof import("./workspace.js").persistWorkspaceFile;
type updateWorkspaceFileStatus = typeof import("./workspace.js").updateWorkspaceFileStatus;
type upsertClawWorkspaceFile = typeof import("./workspace.js").upsertClawWorkspaceFile;
type deleteClawWorkspaceFileRecord = typeof import("./workspace.js").deleteClawWorkspaceFileRecord;
type persistClawMcpPendingRef = typeof import("./mcp.js").persistPendingRef;
type updateClawMcpRef = typeof import("./mcp.js").updateRef;
type upsertClawMcpServerRef = typeof import("./mcp.js").upsertClawMcpServerRef;
type deleteClawMcpServerRef = typeof import("./mcp.js").deleteClawMcpServerRef;
type persistClawCronPendingRef = typeof import("./cron.js").persistPendingRef;
type updateClawCronRef = typeof import("./cron.js").updateRef;
type upsertClawCronRef = typeof import("./cron.js").upsertClawCronRef;
type deleteClawCronRef = typeof import("./cron.js").deleteClawCronRef;
type markClawCronRefRemoved = typeof import("./cron.js").markClawCronRefRemoved;
type replaceClawPackageRefExpected =
  typeof import("./package-update-provenance.js").replaceClawPackageRefExpected;
type recordAgentProvenance = typeof import("../state/agent-provenance.js").recordAgentProvenance;

export type ClawStateWorkerOperations = {
  "claws.state.persistClawInstallRecord": {
    input: {
      args: [Parameters<persistClawInstallRecord>[0]];
      options: Omit<
        NonNullable<Parameters<persistClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<persistClawInstallRecord>;
  };
  "claws.state.updateClawInstallRecord": {
    input: {
      args: [Parameters<updateClawInstallRecord>[0]];
      options: Omit<
        NonNullable<Parameters<updateClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateClawInstallRecord>;
  };
  "claws.state.updateClawInstallRecordStatus": {
    input: {
      args: [
        Parameters<updateClawInstallRecordStatus>[0],
        Parameters<updateClawInstallRecordStatus>[1],
      ];
      options: Omit<
        NonNullable<Parameters<updateClawInstallRecordStatus>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateClawInstallRecordStatus>;
  };
  "claws.state.deleteClawInstallRecord": {
    input: {
      args: [Parameters<deleteClawInstallRecord>[0]];
      options: Omit<
        NonNullable<Parameters<deleteClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<deleteClawInstallRecord>;
  };
  "claws.state.persistClawPackageRef": {
    input: {
      args: [Parameters<persistClawPackageRef>[0], Parameters<persistClawPackageRef>[1]];
      options: Omit<
        NonNullable<Parameters<persistClawPackageRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<persistClawPackageRef>;
  };
  "claws.state.updateClawPackageRefStatus": {
    input: {
      args: [Parameters<updateClawPackageRefStatus>[0], Parameters<updateClawPackageRefStatus>[1]];
      options: Omit<
        NonNullable<Parameters<updateClawPackageRefStatus>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateClawPackageRefStatus>;
  };
  "claws.state.persistWorkspaceFile": {
    input: {
      args: [Parameters<persistWorkspaceFile>[0]];
      options: Omit<
        NonNullable<Parameters<persistWorkspaceFile>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<persistWorkspaceFile>;
  };
  "claws.state.updateWorkspaceFileStatus": {
    input: {
      args: [Parameters<updateWorkspaceFileStatus>[0], Parameters<updateWorkspaceFileStatus>[1]];
      options: Omit<
        NonNullable<Parameters<updateWorkspaceFileStatus>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateWorkspaceFileStatus>;
  };
  "claws.state.upsertClawWorkspaceFile": {
    input: {
      args: [Parameters<upsertClawWorkspaceFile>[0]];
      options: Omit<
        NonNullable<Parameters<upsertClawWorkspaceFile>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<upsertClawWorkspaceFile>;
  };
  "claws.state.deleteClawWorkspaceFileRecord": {
    input: {
      args: [
        Parameters<deleteClawWorkspaceFileRecord>[0],
        Parameters<deleteClawWorkspaceFileRecord>[1],
      ];
      options: Omit<
        NonNullable<Parameters<deleteClawWorkspaceFileRecord>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<deleteClawWorkspaceFileRecord>;
  };
  "claws.state.persistClawMcpPendingRef": {
    input: {
      args: [
        Parameters<persistClawMcpPendingRef>[0],
        Parameters<persistClawMcpPendingRef>[1],
        Parameters<persistClawMcpPendingRef>[2],
        Parameters<persistClawMcpPendingRef>[3],
      ];
      options: Omit<
        NonNullable<Parameters<persistClawMcpPendingRef>[4]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<persistClawMcpPendingRef>;
  };
  "claws.state.updateClawMcpRef": {
    input: {
      args: [Parameters<updateClawMcpRef>[0], Parameters<updateClawMcpRef>[1]];
      options: Omit<
        NonNullable<Parameters<updateClawMcpRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateClawMcpRef>;
  };
  "claws.state.upsertClawMcpServerRef": {
    input: {
      args: [Parameters<upsertClawMcpServerRef>[0]];
      options: Omit<
        NonNullable<Parameters<upsertClawMcpServerRef>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<upsertClawMcpServerRef>;
  };
  "claws.state.deleteClawMcpServerRef": {
    input: {
      args: [Parameters<deleteClawMcpServerRef>[0], Parameters<deleteClawMcpServerRef>[1]];
      options: Omit<
        NonNullable<Parameters<deleteClawMcpServerRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<deleteClawMcpServerRef>;
  };
  "claws.state.persistClawCronPendingRef": {
    input: {
      args: [Parameters<persistClawCronPendingRef>[0], Parameters<persistClawCronPendingRef>[1]];
      options: Omit<
        NonNullable<Parameters<persistClawCronPendingRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<persistClawCronPendingRef>;
  };
  "claws.state.updateClawCronRef": {
    input: {
      args: [Parameters<updateClawCronRef>[0], Parameters<updateClawCronRef>[1]];
      options: Omit<
        NonNullable<Parameters<updateClawCronRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<updateClawCronRef>;
  };
  "claws.state.upsertClawCronRef": {
    input: {
      args: [Parameters<upsertClawCronRef>[0]];
      options: Omit<
        NonNullable<Parameters<upsertClawCronRef>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<upsertClawCronRef>;
  };
  "claws.state.deleteClawCronRef": {
    input: {
      args: [Parameters<deleteClawCronRef>[0], Parameters<deleteClawCronRef>[1]];
      options: Omit<
        NonNullable<Parameters<deleteClawCronRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<deleteClawCronRef>;
  };
  "claws.state.markClawCronRefRemoved": {
    input: {
      args: [Parameters<markClawCronRefRemoved>[0], Parameters<markClawCronRefRemoved>[1]];
      options: Omit<
        NonNullable<Parameters<markClawCronRefRemoved>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<markClawCronRefRemoved>;
  };
  "claws.state.replaceClawPackageRefExpected": {
    input: {
      args: [
        Parameters<replaceClawPackageRefExpected>[0],
        Parameters<replaceClawPackageRefExpected>[1],
      ];
      options: Omit<
        NonNullable<Parameters<replaceClawPackageRefExpected>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<replaceClawPackageRefExpected>;
  };
  "claws.state.recordAgentProvenance": {
    input: {
      args: [Parameters<recordAgentProvenance>[0], Parameters<recordAgentProvenance>[1]];
      options: Omit<
        NonNullable<Parameters<recordAgentProvenance>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
    };
    output: ReturnType<recordAgentProvenance>;
  };
};

export type ClawStateCommand = {
  [K in keyof ClawStateWorkerOperations]: { type: K; input: ClawStateWorkerOperations[K]["input"] };
}[keyof ClawStateWorkerOperations];

export function isClawStateCommand(command: { type: string }): command is ClawStateCommand {
  return Object.hasOwn(clawStateCommands, command.type);
}

const clawStateCommands = {
  "claws.state.persistClawInstallRecord": true,
  "claws.state.updateClawInstallRecord": true,
  "claws.state.updateClawInstallRecordStatus": true,
  "claws.state.deleteClawInstallRecord": true,
  "claws.state.persistClawPackageRef": true,
  "claws.state.updateClawPackageRefStatus": true,
  "claws.state.persistWorkspaceFile": true,
  "claws.state.updateWorkspaceFileStatus": true,
  "claws.state.upsertClawWorkspaceFile": true,
  "claws.state.deleteClawWorkspaceFileRecord": true,
  "claws.state.persistClawMcpPendingRef": true,
  "claws.state.updateClawMcpRef": true,
  "claws.state.upsertClawMcpServerRef": true,
  "claws.state.deleteClawMcpServerRef": true,
  "claws.state.persistClawCronPendingRef": true,
  "claws.state.updateClawCronRef": true,
  "claws.state.upsertClawCronRef": true,
  "claws.state.deleteClawCronRef": true,
  "claws.state.markClawCronRefRemoved": true,
  "claws.state.replaceClawPackageRefExpected": true,
  "claws.state.recordAgentProvenance": true,
} as const;
