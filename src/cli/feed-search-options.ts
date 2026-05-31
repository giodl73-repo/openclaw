import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatFeedInstallCommand,
  type FeedEntryResult,
  type FeedEntryType,
} from "../../extensions/feeds/api.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../config/config.js";

export type CatalogFeedSearchCliOptions = {
  catalogFeeds?: boolean;
  feedSource?: string[];
};

export function splitFeedSourceIds(values: string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const ids = values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return ids.length === 0 ? undefined : [...new Set(ids)];
}

export async function shouldSearchCatalogFeeds(
  opts: CatalogFeedSearchCliOptions,
): Promise<boolean> {
  return (await resolveCatalogFeedSearchOptions(opts)).enabled;
}

export async function resolveCatalogFeedSearchOptions(opts: CatalogFeedSearchCliOptions): Promise<{
  enabled: boolean;
  sourceIds?: string[];
}> {
  const cliSourceIds = splitFeedSourceIds(opts.feedSource);
  if (opts.catalogFeeds === true || cliSourceIds !== undefined) {
    return (await readFeedPluginEnabledForSearch())
      ? { enabled: true, sourceIds: cliSourceIds }
      : { enabled: false };
  }
  return readDefaultCatalogFeedSearchOptions();
}

export async function searchCatalogFeedEntriesForCli(params: {
  queryParts: string[] | string;
  type: FeedEntryType;
  limit?: number;
  opts: CatalogFeedSearchCliOptions;
}): Promise<readonly FeedEntryResult[]> {
  const searchOptions = await resolveCatalogFeedSearchOptions(params.opts);
  if (!searchOptions.enabled) {
    return [];
  }
  const { searchConfiguredFeedEntries } = await import("../../extensions/feeds/api.js");
  return searchConfiguredFeedEntries({
    query: normalizeOptionalString(
      Array.isArray(params.queryParts) ? params.queryParts.join(" ") : params.queryParts,
    ),
    type: params.type,
    sourceIds: searchOptions.sourceIds,
    limit: params.limit,
  });
}

export function formatFeedSearchEntry(entry: FeedEntryResult): string {
  const version = entry.version === undefined ? "" : ` v${entry.version}`;
  const name = entry.name === undefined ? entry.id : entry.name;
  const summary = entry.description === undefined ? "" : theme.muted(` - ${entry.description}`);
  const install = feedInstallHint(entry);
  return `${entry.id}${version}  ${name}${summary}\n  ${theme.muted(`Feed: ${entry.sourceId}/${entry.feedId}`)}${install}`;
}

function feedInstallHint(entry: FeedEntryResult): string {
  const command = formatFeedInstallCommand(entry);
  return command === undefined ? "" : `\n  ${theme.muted(`Install: ${command}`)}`;
}

async function readFeedPluginEnabledForSearch(): Promise<boolean> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return false;
    }
    const plugins = isRecord(snapshot.config.plugins) ? snapshot.config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const feeds = isRecord(entries.feeds) ? entries.feeds : {};
    const config = isRecord(feeds.config) ? feeds.config : {};
    return feedPluginEnabledForDefaultSearch(plugins, feeds, config);
  } catch {
    return false;
  }
}

async function readDefaultCatalogFeedSearchOptions(): Promise<{
  enabled: boolean;
  sourceIds?: string[];
}> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return { enabled: false };
    }
    const plugins = isRecord(snapshot.config.plugins) ? snapshot.config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const feeds = isRecord(entries.feeds) ? entries.feeds : {};
    const config = isRecord(feeds.config) ? feeds.config : {};
    if (!feedPluginEnabledForDefaultSearch(plugins, feeds, config)) {
      return { enabled: false };
    }
    const search = isRecord(config.search) ? config.search : {};
    if (search.default !== true) {
      return { enabled: false };
    }
    if (search.sources !== undefined && !Array.isArray(search.sources)) {
      return { enabled: false };
    }
    return {
      enabled: true,
      sourceIds: Array.isArray(search.sources)
        ? search.sources.filter((id): id is string => typeof id === "string")
        : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

function feedPluginEnabledForDefaultSearch(
  plugins: Record<string, unknown>,
  feeds: Record<string, unknown>,
  config: Record<string, unknown>,
): boolean {
  const allow = readStringArray(plugins.allow);
  const deny = readStringArray(plugins.deny);
  return (
    plugins.enabled !== false &&
    feeds.enabled !== false &&
    config.enabled !== false &&
    !deny.includes("feeds") &&
    (allow.length === 0 || allow.includes("feeds"))
  );
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
