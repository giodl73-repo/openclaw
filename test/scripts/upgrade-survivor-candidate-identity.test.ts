import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const version = "2026.9.6";
type Change =
  | "valid"
  | "stale"
  | "tarball-changed"
  | "tarball-missing"
  | "entrypoint-missing"
  | "wrong-source"
  | "published"
  | "missing-baseline";
type Scenario =
  | "base"
  | "sqlite-volume"
  | "projects-doctor"
  | "workshop-doctor-recovery"
  | "legacy-operator-state";

function runCandidateFlow(scenario: Scenario, change: Change) {
  const fixtureVersion = scenario === "legacy-operator-state" ? "2026.9.9" : version;
  const root = tempDirs.make("upgrade-survivor-candidate-identity-");
  const candidate = path.join(root, "candidate", "package");
  const installed = path.join(root, "installed");
  const artifacts = path.join(root, "artifacts");
  const runtime = path.join(root, "runtime");
  const events = path.join(root, "events");
  const tarball = path.join(root, "candidate.tgz");
  mkdirSync(path.join(candidate, "dist"), { recursive: true });
  mkdirSync(artifacts);
  mkdirSync(runtime);
  writeFileSync(
    path.join(candidate, "package.json"),
    JSON.stringify({ name: "openclaw", version: fixtureVersion }),
  );
  writeFileSync(path.join(candidate, "openclaw.mjs"), "export {};\n");
  writeFileSync(
    path.join(candidate, "dist/build-info.json"),
    JSON.stringify({ version: fixtureVersion, commit: selectedSha }),
  );
  writeFileSync(path.join(candidate, "dist/entry.mjs"), "export const payload = 'candidate';\n");
  cpSync(candidate, installed, { recursive: true });
  writeFileSync(path.join(installed, "dist/entry.mjs"), "export const payload = 'stale';\n");
  writeFileSync(events, "");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(candidate), "package"]);

  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const audited = scenario === "projects-doctor" || scenario === "workshop-doctor-recovery";
  if ((audited || scenario === "legacy-operator-state") && change !== "missing-baseline") {
    writeFileSync(
      path.join(artifacts, "baseline-package-identity.json"),
      JSON.stringify({
        buildInfo: { commit: change === "published" ? selectedSha : "c".repeat(40) },
      }),
    );
  }
  const startMarker =
    scenario === "projects-doctor"
      ? "  phase worker-candidate-identity prepare_worker_cell_package\n"
      : scenario === "workshop-doctor-recovery"
        ? "  phase capture-workshop-candidate-package "
        : "phase resolve-candidate resolve_candidate_version\n";
  const following =
    scenario === "projects-doctor"
      ? "  phase update-worker-candidate "
      : scenario === "workshop-doctor-recovery"
        ? "  phase seed-physical-baseline-index "
        : "run_missing_load_path_fixture post-update\n";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(following, start);
  const helperStart = source.indexOf("prepare_worker_cell_package() {\n");
  const helperEnd = source.indexOf("\nassert_worker_cell_update() {", helperStart);
  const identityStart = source.indexOf("generic_package_identity_enabled() {\n");
  const identityEnd = source.indexOf("\nlegacy_runtime_deps_symlink_plugin() {", identityStart);
  if (
    start < 0 ||
    end < start ||
    helperStart < 0 ||
    helperEnd < helperStart ||
    identityStart < 0 ||
    identityEnd < identityStart
  ) {
    throw new Error("Survivor candidate flow boundaries are unavailable");
  }
  const flow = source.slice(start, audited ? end : end + following.length);
  // Execute the registered scenario flow and real identity CLI; only installation
  // and unrelated fixture phases are replaced by this small package fixture.
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -eu
SCENARIO="$UNIT_SCENARIO"
CANDIDATE_KIND=tarball
CANDIDATE_SPEC="$UNIT_ROOT/candidate.tgz"
ARTIFACT_ROOT="$UNIT_ROOT/artifacts"
RUNTIME_ROOT="$UNIT_ROOT/runtime"
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
candidate_version="$UNIT_VERSION"
candidate_install_mode=updater
baseline_version="$UNIT_VERSION"
baseline_identity_path=""
if [ "$SCENARIO" = legacy-operator-state ]; then
  baseline_identity_path="$ARTIFACT_ROOT/baseline-package-identity.json"
fi
native_assignment_enabled=0
plugin_registry_pid=""
UPDATE_RESTART_MODE=manual
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT"
node() { "$UNIT_NODE" "$@"; }
${source.slice(helperStart, helperEnd)}
${source.slice(identityStart, identityEnd)}
package_root() { printf '%s\\n' "$UNIT_ROOT/installed"; }
openclaw_e2e_stop_process() { :; }
companion_survivor_scenario() { return 1; }
run_plugin_fixture_phase() { :; }
run_missing_load_path_fixture() {
  if [ "$1" = post-update ]; then
    printf 'following-phase\\n' >> "$UNIT_ROOT/events"
  fi
}
update_candidate_for_install_mode() {
  printf 'updater\\n' >> "$UNIT_ROOT/events"
  if [ "$UNIT_CHANGE" != stale ]; then
    cp -R "$UNIT_ROOT/candidate/package/." "$UNIT_ROOT/installed/"
  fi
  if [ "$UNIT_CHANGE" = tarball-changed ]; then
    printf '\\n' >> "$CANDIDATE_SPEC"
  fi
  if [ "$UNIT_CHANGE" = tarball-missing ]; then
    rm "$CANDIDATE_SPEC"
  fi
  if [ "$UNIT_CHANGE" = entrypoint-missing ]; then
    rm "$UNIT_ROOT/installed/openclaw.mjs"
  fi
}
phase() {
  shift
  case "$1" in
    node)
      if [ "$2" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ]; then
        shift
        "$UNIT_NODE" "$@"
      fi ;;
    update_candidate_for_install_mode|prepare_worker_cell_package) "$@" ;;
    *) : ;;
  esac
}
${flow}
`,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        UNIT_ROOT: root,
        UNIT_NODE: resolveTestNodeExecPath(),
        UNIT_SCENARIO: scenario,
        UNIT_CHANGE: change,
        UNIT_VERSION: fixtureVersion,
        OPENCLAW_DOCKER_E2E_SELECTED_SHA: change === "wrong-source" ? "b".repeat(40) : selectedSha,
      },
    },
  );
  return {
    result,
    artifacts,
    events: readFileSync(events, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe.skipIf(process.platform === "win32")(
  "published survivor candidate identity admission",
  () => {
    it.each([undefined, "/proof/published.tgz", ""])(
      "preserves absent versus supplied baseline archive (%s)",
      (archive) => {
        const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
        const start = source.indexOf("phase install-baseline install_baseline\n");
        const end = source.indexOf("phase initialize-state initialize_state\n", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const env = { ...process.env };
        delete env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_TARBALL;
        if (archive !== undefined) env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_TARBALL = archive;
        const result = spawnSync(
          "/bin/bash",
          [
            "-c",
            `set -eu
SCENARIO=legacy-operator-state
ARTIFACT_ROOT=/proof/artifacts
generic_package_identity_enabled() { return 0; }
package_root() { printf /proof/installed; }
phase() {
  if [ "$1" = baseline-package-identity ]; then
    shift
    printf '<%s>\\n' "$@"
  fi
}
${source.slice(start, end)}
`,
          ],
          { encoding: "utf8", env },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
          "<node>",
          "<scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs>",
          "<baseline>",
          "</proof/installed>",
          ...(archive === undefined ? [] : [`<${archive}>`]),
        ]);
      },
    );

    it.each(["base", "sqlite-volume", "legacy-operator-state"] as const)(
      "%s accepts the exact tarball payload and rejects stale same-version installed bytes",
      (scenario) => {
        const stale = runCandidateFlow(scenario, "stale");
        expect(stale.result.status).not.toBe(0);
        expect(stale.result.stderr).toContain(
          "Installed application payload differs from the frozen tarball",
        );
        expect(stale.events).toEqual(["updater"]);
        expect(existsSync(path.join(stale.artifacts, "installed-package-identity.json"))).toBe(
          false,
        );

        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(valid.events).toEqual(["updater", "following-phase"]);
        const installed = JSON.parse(
          readFileSync(path.join(valid.artifacts, "installed-package-identity.json"), "utf8"),
        );
        expect(installed.version).toBe(scenario === "legacy-operator-state" ? "2026.9.9" : version);
        expect(installed.buildInfo.commit).toBe(selectedSha);
      },
    );

    it.each([
      {
        change: "wrong-source",
        error: "Candidate build commit must equal the selected source SHA",
        events: [],
      },
      { change: "tarball-changed", error: "Candidate tarball changed", events: ["updater"] },
      { change: "tarball-missing", error: "Candidate tarball changed", events: ["updater"] },
      {
        change: "entrypoint-missing",
        error: "Installed application payload differs from the frozen tarball",
        events: ["updater"],
      },
    ] as const)("refuses $change at the actual candidate boundary", ({ change, error, events }) => {
      const observed = runCandidateFlow("base", change);
      expect(observed.result.status).not.toBe(0);
      expect(observed.result.stderr).toContain(error);
      expect(observed.events).toEqual(events);
      expect(existsSync(path.join(observed.artifacts, "installed-package-identity.json"))).toBe(
        false,
      );
    });

    it.each(["projects-doctor", "workshop-doctor-recovery", "legacy-operator-state"] as const)(
      "%s requires its audited baseline and refuses published candidate bytes",
      (scenario) => {
        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(existsSync(path.join(valid.artifacts, "candidate-package-identity.json"))).toBe(
          true,
        );

        for (const [change, error] of [
          ["published", "Candidate still contains published bytes"],
          ["missing-baseline", "ENOENT"],
        ] as const) {
          const refused = runCandidateFlow(scenario, change);
          expect(refused.result.status).not.toBe(0);
          expect(refused.result.stderr).toContain(error);
          expect(refused.events).toEqual([]);
          expect(existsSync(path.join(refused.artifacts, "candidate-package-identity.json"))).toBe(
            false,
          );
        }
      },
    );
  },
);
