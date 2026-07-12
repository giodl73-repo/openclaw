import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigSchema } from "../config/schema.js";
import { resolveContinuityArchivePlanFromPaths } from "./archive-plan.js";

const tempDirs: string[] = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-continuity-plan-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(stateDir, "workspace");
  const oauthDir = path.join(stateDir, "credentials");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.writeFileSync(configPath, `{ gateway: { port: 18789 } }`);
  return { root, stateDir, workspaceDir, oauthDir, configPath };
}

function resolveFixture(
  fixture: ReturnType<typeof makeFixture>,
  overrides: Partial<Parameters<typeof resolveContinuityArchivePlanFromPaths>[0]> = {},
) {
  return resolveContinuityArchivePlanFromPaths({
    stateDir: fixture.stateDir,
    configPath: fixture.configPath,
    configRaw: fs.readFileSync(fixture.configPath, "utf8"),
    oauthDir: fixture.oauthDir,
    workspaceDirs: [fixture.workspaceDir],
    uiHints: buildConfigSchema().uiHints,
    extensionMetadataComplete: true,
    nowMs: 0,
    ...overrides,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("continuity archive plan", () => {
  it("separates config, workspaces, and OAuth from the sanitizable state source", () => {
    const fixture = makeFixture();
    const plan = resolveFixture(fixture);

    expect(plan.eligible).toBe(true);
    expect(plan.archiveRoot).toMatch(/-openclaw-continuity$/);
    expect(plan.sqliteTreatment).toBe("snapshot-sanitize-and-verify");
    expect(plan.sources.config.map((source) => source.sourcePath)).toEqual([fixture.configPath]);
    expect(plan.sources.workspaces.map((source) => source.sourcePath)).toEqual([
      fixture.workspaceDir,
    ]);
    expect(plan.sources.state.excludePaths).toEqual(
      [fixture.configPath, fixture.oauthDir, fixture.workspaceDir].toSorted(),
    );
    expect(plan.evidence).toMatchObject({
      configFileCount: 1,
      workspaceCount: 1,
      oauthExcluded: true,
      legacyTranscriptCount: 0,
    });
  });

  it("captures the complete guarded config include closure separately", () => {
    const fixture = makeFixture();
    const nestedPath = path.join(fixture.stateDir, "gateway.json5");
    fs.writeFileSync(nestedPath, `{ gateway: { port: 18789 } }`);
    fs.writeFileSync(fixture.configPath, `{ $include: "./gateway.json5" }`);

    const plan = resolveFixture(fixture);

    expect(plan.eligible).toBe(true);
    expect(plan.sources.config.map((source) => source.sourcePath)).toEqual([
      fixture.configPath,
      nestedPath,
    ]);
    expect(plan.evidence.config.includeFileCount).toBe(1);
    expect(plan.sources.state.excludePaths).toContain(nestedPath);
  });

  it("excludes separately captured config files from a containing workspace", () => {
    const fixture = makeFixture();
    const configPath = path.join(fixture.workspaceDir, "openclaw.json");
    const includedPath = path.join(fixture.workspaceDir, "gateway.json5");
    fs.writeFileSync(configPath, `{ $include: "./gateway.json5" }`);
    fs.writeFileSync(includedPath, `{ gateway: { port: 18789 } }`);

    const plan = resolveFixture(fixture, {
      configPath,
      configRaw: fs.readFileSync(configPath, "utf8"),
    });

    expect(plan.eligible).toBe(true);
    expect(plan.sources.workspaces[0]?.excludePaths).toEqual([includedPath, configPath]);
  });

  it("fails closed when authoritative legacy transcripts remain", () => {
    const fixture = makeFixture();
    const sessionDir = path.join(fixture.stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "legacy.jsonl"), "{}\n");

    const plan = resolveFixture(fixture);

    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toContainEqual({
      code: "continuity.capture.legacy_transcripts",
      count: 1,
    });
    expect(plan.evidence.legacyTranscriptCount).toBe(1);
  });

  it("fails closed on missing sources and incomplete extension metadata", () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.workspaceDir, { recursive: true });

    const plan = resolveFixture(fixture, {
      extensionMetadataComplete: false,
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toEqual([
      {
        code: "continuity.config.extension_metadata_incomplete",
        count: 1,
      },
      {
        code: "continuity.capture.source_missing",
        count: 1,
      },
    ]);
  });

  it("fails closed when a workspace would recursively contain the state source", () => {
    const fixture = makeFixture();

    const plan = resolveFixture(fixture, {
      workspaceDirs: [fixture.root],
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toContainEqual({
      code: "continuity.capture.source_overlap",
      count: 1,
    });
  });

  it("fails closed when authored config is inside the excluded OAuth directory", () => {
    const fixture = makeFixture();
    const configPath = path.join(fixture.oauthDir, "openclaw.json");
    fs.writeFileSync(configPath, `{ gateway: { port: 18789 } }`);

    const plan = resolveFixture(fixture, {
      configPath,
      configRaw: fs.readFileSync(configPath, "utf8"),
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toContainEqual({
      code: "continuity.capture.source_overlap",
      count: 1,
    });
  });
});
