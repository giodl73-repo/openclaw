import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  release: vi.fn(),
  artifact: vi.fn(),
  trust: vi.fn(),
  download: vi.fn(),
  cleanup: vi.fn(),
  extract: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../infra/clawhub-packages.js", () => ({
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageVersion: mocks.release,
  fetchClawHubPackageArtifact: mocks.artifact,
}));
vi.mock("../infra/clawhub-install-trust.js", () => ({ checkClawHubPackageTrust: mocks.trust }));
vi.mock("../infra/clawhub-artifacts.js", () => ({ downloadClawHubPackageArchive: mocks.download }));
vi.mock("../infra/install-flow.js", () => ({ withExtractedArchiveRoot: mocks.extract }));
vi.mock("./reader.js", () => ({ readClawManifestFile: mocks.read }));
vi.mock("node:fs/promises", () => ({ default: { stat: async () => ({ size: 100 }) } }));

import { readClawHubClawDetail, withResolvedClawHubSource } from "./clawhub-source.js";

const digest = "a".repeat(64);
const source = { packageName: "@owner/assistant", version: "1.2.3" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.detail.mockResolvedValue({
    package: {
      name: source.packageName,
      family: "claw",
      displayName: "Assistant",
      latestVersion: source.version,
      channel: "official",
      isOfficial: true,
    },
    owner: { handle: "owner", displayName: "Example Owner" },
  });
  mocks.release.mockResolvedValue({
    package: { name: source.packageName, family: "claw" },
    version: { version: source.version },
  });
  mocks.artifact.mockResolvedValue({
    package: { name: source.packageName, family: "claw" },
    version: source.version,
    artifact: {
      artifactKind: "npm-pack",
      artifactSha256: digest,
      packageName: source.packageName,
      version: source.version,
    },
  });
  mocks.trust.mockResolvedValue({
    ok: true,
    trustInstallRecordFields: { clawhubTrustDisposition: "clean" },
  });
  mocks.download.mockResolvedValue({
    sha256Hex: digest,
    archivePath: "/fixture/package.tgz",
    cleanup: mocks.cleanup,
  });
  mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted("/fixture/source"));
  mocks.read.mockResolvedValue({
    ok: true,
    source: {
      kind: "package",
      name: source.packageName,
      version: source.version,
      packageRoot: "/fixture/source",
    },
    manifest: {
      agent: { id: "assistant", name: "Assistant" },
      workspace: { files: [], bootstrapFiles: {} },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    },
  });
});

describe("exact ClawHub source", () => {
  it("binds publisher and trust facts without making check timestamps part of consent", async () => {
    const run = async (_source: unknown, trust: { integrity: string }) => trust.integrity;
    const request = { coordinate: source, mode: "preview" as const, run };
    const first = await withResolvedClawHubSource(request);
    mocks.trust.mockResolvedValue({
      ok: true,
      trustInstallRecordFields: {
        clawhubTrustDisposition: "clean",
        clawhubTrustCheckedAt: "2026-09-30T12:00:00Z",
      },
    });
    expect((await withResolvedClawHubSource(request)).value).toBe(first.value);
    const detail = await mocks.detail();
    detail.owner.handle = "new-owner";
    mocks.detail.mockResolvedValue(detail);
    expect((await withResolvedClawHubSource(request)).value).not.toBe(first.value);
  });

  it("resolves latest to an exact release and projects actual publisher identity", async () => {
    const detail = await readClawHubClawDetail({ packageName: source.packageName });
    expect(detail).toMatchObject({
      version: "1.2.3",
      publisher: "Example Owner (@owner)",
      official: true,
    });
    expect(mocks.release).toHaveBeenCalledWith({
      name: source.packageName,
      version: source.version,
    });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("never invents a publisher from the official channel", async () => {
    const detail = await mocks.detail();
    delete detail.owner;
    mocks.detail.mockResolvedValue(detail);
    expect(await readClawHubClawDetail(source)).not.toHaveProperty("publisher");
  });

  it("rejects a wrong exact release instead of using latest metadata", async () => {
    mocks.release.mockResolvedValue({
      package: { name: source.packageName, family: "claw" },
      version: { version: "9.0.0" },
    });
    await expect(readClawHubClawDetail(source)).rejects.toThrow("identity changed");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("rejects mutable coordinates before contacting ClawHub", async () => {
    await expect(readClawHubClawDetail({ ...source, version: "latest" })).rejects.toThrow(
      "exact release",
    );
    await expect(readClawHubClawDetail({ packageName: "../private" })).rejects.toThrow("canonical");
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("rejects disagreement between the resolved artifact and release identities", async () => {
    const artifact = await mocks.artifact();
    artifact.artifact.version = "9.0.0";
    mocks.artifact.mockResolvedValue(artifact);
    await expect(
      withResolvedClawHubSource({ coordinate: source, mode: "preview", run: vi.fn() }),
    ).rejects.toThrow("immutable");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("includes profile extensions and implicit workspace content in detail counts", async () => {
    const loaded = await mocks.read();
    loaded.openClawProfile = { extensions: [{ id: "extension" }] };
    loaded.clawMarkdownBody = Buffer.from("Assistant instructions");
    loaded.packageBootstrap = { sourcePath: "BOOTSTRAP.md" };
    mocks.read.mockResolvedValue(loaded);
    expect(await readClawHubClawDetail(source)).toMatchObject({ plugins: 1, workspaceFiles: 2 });
  });

  it("rejects tampered artifacts before the lifecycle callback", async () => {
    mocks.download.mockResolvedValue({
      sha256Hex: "b".repeat(64),
      archivePath: "/fixture/package.tgz",
      cleanup: mocks.cleanup,
    });
    const run = vi.fn();
    await expect(
      withResolvedClawHubSource({ coordinate: source, mode: "apply", run }),
    ).rejects.toThrow("digest changed");
    expect(run).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("requires explicit risk acknowledgement during apply", async () => {
    mocks.trust.mockResolvedValue({
      ok: true,
      warning: "Review this release.",
      trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
    });
    const run = vi.fn(async () => "preview");
    const preview = await withResolvedClawHubSource({ coordinate: source, mode: "preview", run });
    expect(preview.riskAcknowledgementRequired).toBe(true);
    run.mockClear();
    await expect(
      withResolvedClawHubSource({ coordinate: source, mode: "apply", run }),
    ).rejects.toThrow("acknowledge");
    expect(run).not.toHaveBeenCalled();
    await expect(
      withResolvedClawHubSource({
        coordinate: source,
        mode: "apply",
        acknowledgeClawHubRisk: true,
        run,
      }),
    ).resolves.toMatchObject({ value: "preview" });
  });

  it("does not allow preview callbacks to persist source content", async () => {
    await expect(
      withResolvedClawHubSource({
        coordinate: source,
        mode: "preview",
        run: async (_loaded, _trust, persist) => await persist(),
      }),
    ).rejects.toThrow("cannot persist");
  });
});
