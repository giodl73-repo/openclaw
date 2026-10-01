import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { readClawInventory } from "./inventory-read.js";
import type * as provenance from "./provenance.js";

export async function readClawInstallRecordAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./provenance.js")).readClawInstallRecord(agentId, options);
  }
  return (await readClawInventory(options)).installs.find((entry) => entry.agentId === agentId);
}

export async function readClawInstallRecordsAsync(options: OpenClawStateDatabaseOptions = {}) {
  if (options.database) {
    return (await import("./provenance.js")).readClawInstallRecords(options);
  }
  return (await readClawInventory(options)).installs;
}

export async function readClawPackageRefsAsync(
  options: NonNullable<Parameters<typeof provenance.readClawPackageRefs>[0]> = {},
) {
  if (options.database) {
    return (await import("./provenance.js")).readClawPackageRefs(options);
  }
  const refs = (await readClawInventory(options)).packages;
  return refs.filter(
    (entry) =>
      (options.agentId === undefined || entry.agentId === options.agentId) &&
      (options.kind === undefined || entry.kind === options.kind) &&
      (options.source === undefined || entry.source === options.source) &&
      (options.ref === undefined || entry.ref === options.ref) &&
      (options.version === undefined || entry.version === options.version) &&
      (options.integrity === undefined || entry.integrity === options.integrity) &&
      (options.status === undefined || entry.status === options.status),
  );
}

export async function readClawWorkspaceFilesAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./workspace.js")).readClawWorkspaceFiles(agentId, options);
  }
  return (await readClawInventory(options)).workspaceFiles.filter(
    (entry) => entry.agentId === agentId,
  );
}

export async function readWorkspaceFileAsync(
  agentId: string,
  pathname: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./workspace.js")).readWorkspaceFile(agentId, pathname, options);
  }
  const record = (await readClawWorkspaceFilesAsync(agentId, options)).find(
    (entry) => entry.path === pathname,
  );
  if (record) {
    const { assertSupportedClawWorkspaceFileState } = await import("./workspace.js");
    assertSupportedClawWorkspaceFileState(record.schemaVersion, record.status, pathname);
  }
  return record;
}

export async function readClawMcpServerRefsAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./mcp.js")).readClawMcpServerRefs(agentId, options);
  }
  return (await readClawInventory(options)).mcpServers.filter((entry) => entry.agentId === agentId);
}

export async function readClawMcpServerRefsByNameAsync(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./mcp.js")).readClawMcpServerRefsByName(name, options);
  }
  return (await readClawInventory(options)).mcpServers.filter((entry) => entry.name === name);
}

export async function readClawCronRefsAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  if (options.database) {
    return (await import("./cron.js")).readClawCronRefs(agentId, options);
  }
  return (await readClawInventory(options)).cronJobs.filter((entry) => entry.agentId === agentId);
}
