// ClawHub source resolution verifies exact immutable artifacts before lifecycle planning.
import fs from "node:fs/promises";
import type { ClawCatalogDetail } from "../../packages/gateway-protocol/src/index.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { downloadClawHubPackageArchive } from "../infra/clawhub-artifacts.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import { normalizeClawHubSha256Hex } from "../infra/clawhub-integrity.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  type ClawHubPackageDetail,
} from "../infra/clawhub-packages.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { digestClawValue } from "./digest.js";
import { readClawManifestFile } from "./reader.js";
import { isCanonicalClawHubPackageName, isExactSemVer } from "./schema-portability.js";
import type { ClawReadResult } from "./types.js";

const CLAWHUB_TIMEOUT_MS = 30_000;

export type ClawHubCoordinate = { packageName: string; version: string };

export class ClawHubSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly warning?: string,
  ) {
    super(message);
    this.name = "ClawHubSourceError";
  }
}

function requireClawPackage(detail: ClawHubPackageDetail, requestedName: string) {
  const pkg = detail.package;
  if (!pkg || pkg.family !== "claw" || pkg.name !== requestedName) {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub package identity changed.");
  }
  return pkg;
}

export function projectClawHubBrowserWarning(warning?: string): string | undefined {
  if (!warning) {
    return undefined;
  }
  const lines: string[] = [];
  for (const rawLine of stripAnsi(warning).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^╰─+╯$/u.test(trimmed)) {
      continue;
    }
    const title = /^╭─\s*(.*?)\s*─+╮$/u.exec(trimmed)?.[1];
    const body = /^│(.*)│$/u.exec(trimmed)?.[1];
    const line = sanitizeTerminalText(title ?? body ?? trimmed).trim();
    if (line && lines.at(-1) !== line) {
      lines.push(line);
    }
  }
  return lines.join("\n") || "Review the ClawHub security details before applying this release.";
}

export async function readClawHubClawDetail(params: {
  packageName: string;
  version?: string;
}): Promise<ClawCatalogDetail> {
  assertCoordinate(params);
  const detail = await fetchClawHubPackageDetail({ name: params.packageName });
  const pkg = requireClawPackage(detail, params.packageName);
  const version = params.version ?? pkg.latestVersion;
  if (!version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub has no published version.",
    );
  }
  assertCoordinate({ packageName: pkg.name, version });
  const release = await fetchClawHubPackageVersion({ name: pkg.name, version });
  if (release.package?.name !== pkg.name || release.package.family !== "claw") {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub release identity changed.");
  }
  if (release.version?.version !== version) {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub release identity changed.");
  }
  const resolved = await withResolvedClawHubSource({
    coordinate: { packageName: pkg.name, version },
    run: async ({ manifest, openClawProfile, clawMarkdownBody, packageBootstrap }, trust) => ({
      packageName: pkg.name,
      displayName: pkg.displayName,
      ...(pkg.summary ? { summary: pkg.summary } : {}),
      channel: pkg.channel,
      official: pkg.isOfficial,
      version,
      ...(trust.publisher ? { publisher: trust.publisher } : {}),
      ...(manifest.agent.name ? { agentName: manifest.agent.name } : {}),
      ...(manifest.agent.description ? { agentDescription: manifest.agent.description } : {}),
      workspaceFiles:
        manifest.workspace.files.length +
        Object.keys(manifest.workspace.bootstrapFiles).length +
        (clawMarkdownBody?.toString("utf8").trim() ? 1 : 0) +
        (packageBootstrap ? 1 : 0),
      skills: manifest.packages.filter((entry) => entry.kind === "skill").length,
      plugins:
        manifest.packages.filter((entry) => entry.kind === "plugin").length +
        (openClawProfile?.extensions?.length ?? 0),
      mcpServers: Object.keys(manifest.mcpServers).length,
      scheduledJobs: manifest.cronJobs.length,
      ...(release.version?.verification?.scanStatus
        ? { scanStatus: release.version.verification.scanStatus }
        : {}),
    }),
  });
  return resolved.value;
}

function projectPublisher(detail: ClawHubPackageDetail): Pick<ClawCatalogDetail, "publisher"> {
  const clean = (value?: string | null) =>
    value ? sanitizeTerminalText(stripAnsi(value)).replace(/\s+/gu, " ").trim() : undefined;
  const handle = clean(detail.owner?.handle) || clean(detail.package?.ownerHandle);
  const displayName = clean(detail.owner?.displayName);
  return handle || displayName
    ? {
        publisher:
          displayName && handle ? `${displayName} (@${handle})` : (displayName ?? `@${handle}`),
      }
    : {};
}

function assertCoordinate(coordinate: { packageName: string; version?: string }): void {
  if (
    !isCanonicalClawHubPackageName(coordinate.packageName) ||
    (coordinate.version !== undefined && !isExactSemVer(coordinate.version))
  ) {
    throw new ClawHubSourceError(
      "clawhub_coordinate_invalid",
      "Select a canonical ClawHub package and an exact release version.",
    );
  }
}

type ResolvedClawHubSource = Extract<ClawReadResult, { ok: true }>;

export type ClawHubSourceTrust = {
  trustWarning?: string;
  riskAcknowledgementRequired: boolean;
  publisher?: string;
  integrity: string;
};

async function readVerifiedArtifactSource(params: {
  sourceRoot: string;
  packageName: string;
  version: string;
  artifactSha256: string;
  artifactByteLength: number;
}): Promise<ResolvedClawHubSource> {
  const loaded = await readClawManifestFile(params.sourceRoot);
  if (!loaded.ok) {
    throw new ClawHubSourceError(
      "clawhub_manifest_invalid",
      loaded.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
    );
  }
  if (loaded.source.name !== params.packageName || loaded.source.version !== params.version) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "Downloaded Claw package identity does not match the selected release.",
    );
  }
  return {
    ...loaded,
    source: {
      ...loaded.source,
      integrityKind: "artifact",
      integrity: `sha256:${params.artifactSha256}`,
      byteLength: params.artifactByteLength,
    },
  };
}

export async function withResolvedClawHubSource<T>(params: {
  coordinate: ClawHubCoordinate;
  run: (source: ResolvedClawHubSource, trust: ClawHubSourceTrust) => Promise<T>;
}): Promise<{ value: T; trustWarning?: string; riskAcknowledgementRequired: boolean }> {
  const { packageName, version } = params.coordinate;
  assertCoordinate(params.coordinate);
  const artifact = await fetchClawHubPackageArtifact({ name: packageName, version });
  const artifactVersion =
    typeof artifact.version === "string" ? artifact.version : artifact.version?.version;
  if (
    artifact.package?.name !== packageName ||
    artifact.package.family !== "claw" ||
    artifactVersion !== version ||
    artifact.artifact?.artifactKind !== "npm-pack" ||
    artifact.artifact.packageName !== packageName ||
    artifact.artifact.version !== version
  ) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub did not return an immutable ClawPack artifact.",
    );
  }
  const expectedSha256 = normalizeClawHubSha256Hex(artifact.artifact.artifactSha256 ?? "");
  if (!expectedSha256) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub did not return a valid artifact digest.",
    );
  }

  const metadata = await fetchClawHubPackageDetail({ name: packageName });
  requireClawPackage(metadata, packageName);
  const trust = await checkClawHubPackageTrust({
    subject: { kind: "claw", packageName },
    version,
  });
  if (!trust.ok) {
    throw new ClawHubSourceError(trust.code ?? "clawhub_trust_failed", trust.error, trust.warning);
  }
  const browserWarning = projectClawHubBrowserWarning(trust.warning);
  const { clawhubTrustCheckedAt: _checkedAt, ...trustFacts } = trust.trustInstallRecordFields;
  const trustProjection = {
    integrity: digestClawValue({ ...trustFacts, ...projectPublisher(metadata) }),
    ...(browserWarning ? { trustWarning: browserWarning } : {}),
    ...projectPublisher(metadata),
    riskAcknowledgementRequired:
      trust.trustInstallRecordFields.clawhubTrustDisposition === "review-required",
  };
  const download = await downloadClawHubPackageArchive({
    name: packageName,
    version,
    artifact: "clawpack",
    timeoutMs: CLAWHUB_TIMEOUT_MS,
  });
  try {
    if (download.sha256Hex !== expectedSha256) {
      throw new ClawHubSourceError(
        "clawhub_artifact_integrity_mismatch",
        "ClawHub artifact digest changed during download.",
      );
    }
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-claw-source-",
      timeoutMs: CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md", "claw.json"],
      onExtracted: async (rootDir) => {
        const artifactSource = await readVerifiedArtifactSource({
          sourceRoot: rootDir,
          packageName,
          version,
          artifactSha256: expectedSha256,
          artifactByteLength,
        });
        return {
          ok: true as const,
          value: await params.run(artifactSource, trustProjection),
        };
      },
    });
    if (!extracted.ok || !("value" in extracted)) {
      throw new ClawHubSourceError("clawhub_extract_failed", extracted.error);
    }
    return {
      value: extracted.value,
      ...trustProjection,
    };
  } finally {
    await download.cleanup();
  }
}
