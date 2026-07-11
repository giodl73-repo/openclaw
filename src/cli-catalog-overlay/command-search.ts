import type { CliCatalogList } from "./list.js";

export type CommandSearchEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "descriptor" | "operation" | "runtime" | "plugin" | "node";
  readonly sourceId: string;
  readonly searchText?: string;
  readonly detail: unknown;
};

export type CommandSearchHit = Pick<CommandSearchEntry, "id" | "name" | "description" | "kind">;

export function buildCommandSearchEntries(list: CliCatalogList): readonly CommandSearchEntry[] {
  return [
    ...list.cli.descriptors.map((entry) => ({
      id: `descriptor:${entry.sourceKind}:${entry.sourceId}`,
      name: entry.name,
      description: entry.description,
      kind: "descriptor" as const,
      sourceId: entry.sourceId,
      detail: entry,
    })),
    ...list.cli.routedOperations.map((entry) => ({
      id: `operation:${entry.id}`,
      name: entry.id,
      description: entry.commandPaths.map((path) => path.join(" ")).join(", "),
      kind: "operation" as const,
      sourceId: entry.id,
      detail: entry,
    })),
    ...list.cli.runtimeCommands.map((entry) => ({
      id: `runtime:${entry.commandPath.join(" ")}`,
      name: entry.commandPath.join(" "),
      description: entry.description,
      kind: "runtime" as const,
      sourceId: entry.sourceId,
      searchText: entry.aliases.join(" "),
      detail: entry,
    })),
    ...list.cli.pluginCommands.map((entry) => ({
      id: `plugin:${entry.pluginId}:${entry.commandPath.join(" ")}`,
      name: entry.commandPath.join(" "),
      description: entry.description,
      kind: "plugin" as const,
      sourceId: entry.sourceId,
      detail: entry,
    })),
    ...list.cli.nodeCommands.map((entry) => ({
      id: `node:${entry.nodeId ?? "any"}:${entry.command}`,
      name: entry.command,
      description: entry.description,
      kind: "node" as const,
      sourceId: entry.sourceId,
      detail: entry,
    })),
  ].toSorted((a, b) => a.id.localeCompare(b.id));
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function score(entry: CommandSearchEntry, terms: readonly string[]): number {
  const name = entry.name.toLowerCase();
  const descriptionTokens = new Set(tokenize(`${entry.description} ${entry.searchText ?? ""}`));
  return terms.reduce((total, term) => {
    if (name === term) return total + 20;
    if (name.startsWith(term)) return total + 10;
    if (name.includes(term)) return total + 6;
    return total + (descriptionTokens.has(term) ? 2 : 0);
  }, 0);
}

/** Returns compact, non-executable command matches for progressive disclosure. */
export function searchCommandEntries(
  entries: readonly CommandSearchEntry[],
  query: string,
  limit = 8,
): readonly CommandSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  return entries
    .map((entry) => ({ entry, score: score(entry, terms) }))
    .filter((candidate) => candidate.score > 0)
    .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, boundedLimit)
    .map(({ entry }) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
    }));
}

export function describeCommandEntry(
  entries: readonly CommandSearchEntry[],
  id: string,
): CommandSearchEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
