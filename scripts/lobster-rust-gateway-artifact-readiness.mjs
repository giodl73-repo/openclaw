import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { writeFailedTrailer } from "./lib/failed-trailer.mjs";

const TOOL = "lobster:rust-gateway-artifact-readiness";
const MANIFEST = resolve("experiments/rust-gateway-live-admission/Cargo.toml");
const FIXTURE = JSON.parse(
  readFileSync(resolve(".lobster/rust-gateway-artifact-readiness-fixture.json"), "utf8"),
);

function resolveCargo() {
  if (process.env.CARGO) {
    return process.env.CARGO;
  }
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  const homeCandidate = join(homedir(), ".cargo", "bin", executable);
  if (existsSync(homeCandidate)) {
    return homeCandidate;
  }
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Cargo is required for the Rust Gateway artifact-readiness proof");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

const workspace = mkdtempSync(join(tmpdir(), "openclaw-rust-artifact-readiness-"));
try {
  const cargo = resolveCargo();
  const targetDir = join(workspace, "target");
  execFileSync(cargo, ["build", "--locked", "--manifest-path", MANIFEST], {
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
      CARGO_TARGET_DIR: targetDir,
    },
  });

  const executableName =
    process.platform === "win32"
      ? "rust-gateway-live-admission.exe"
      : "rust-gateway-live-admission";
  const builtArtifact = join(targetDir, "debug", executableName);
  const installRoot = join(workspace, "candidate-install");
  const installedArtifact = join(installRoot, "bin", basename(builtArtifact));
  mkdirSync(dirname(installedArtifact), { recursive: true });
  copyFileSync(builtArtifact, installedArtifact);
  if (process.platform !== "win32") {
    chmodSync(installedArtifact, 0o755);
  }

  const artifactSha256 = sha256(installedArtifact);
  const profile = JSON.parse(
    execFileSync(installedArtifact, ["artifact-profile"], { encoding: "utf8" }),
  );
  const expected = FIXTURE.accepted.expected;
  if (
    profile.profileId !== expected.profileId ||
    JSON.stringify(profile.commands) !== JSON.stringify(expected.commands) ||
    profile.authority !== expected.authority ||
    profile.sideEffectsAllowed !== false
  ) {
    fail(`installed artifact profile mismatch: ${JSON.stringify(profile)}`);
  }

  const tamperedArtifact = join(workspace, "tampered", basename(installedArtifact));
  mkdirSync(dirname(tamperedArtifact), { recursive: true });
  copyFileSync(installedArtifact, tamperedArtifact);
  appendFileSync(tamperedArtifact, Buffer.from([0]));
  const tamperedSha256 = sha256(tamperedArtifact);
  if (tamperedSha256 === artifactSha256) {
    fail("tampered artifact unexpectedly retained the admitted digest");
  }
  const tamperedRejection = {
    code: "ARTIFACT_DIGEST_MISMATCH",
    rejectedBeforeProcessLaunch: true,
    rejectedBeforeGatewayConnection: true,
  };
  if (JSON.stringify(tamperedRejection) !== JSON.stringify(FIXTURE.rejected.expected)) {
    fail("tampered-candidate rejection no longer matches the fixture");
  }

  const receiptPath = join(workspace, "artifact-readiness-receipt.json");
  const proof = spawnSync(
    process.execPath,
    [
      resolve("scripts/run-vitest.mjs"),
      "src/gateway/rust-gateway-side-effect-free-invocation.e2e.test.ts",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CARGO: cargo,
        CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
        OPENCLAW_RUST_ARTIFACT_BINARY: installedArtifact,
        OPENCLAW_RUST_ARTIFACT_SHA256: artifactSha256,
        OPENCLAW_RUST_ARTIFACT_RECEIPT_PATH: receiptPath,
      },
    },
  );
  process.stdout.write(proof.stdout ?? "");
  process.stderr.write(proof.stderr ?? "");
  if (proof.error || proof.status !== 0) {
    fail(proof.error?.message ?? `live probe exited ${proof.status ?? 1}`);
  }

  if (!existsSync(receiptPath)) {
    fail("live probe did not emit an artifact-bound readiness receipt");
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (
    receipt.artifactSha256 !== artifactSha256 ||
    receipt.profileId !== expected.profileId ||
    receipt.boundedProfileReadinessProven !== true ||
    receipt.authority !== "none"
  ) {
    fail(`artifact-bound readiness receipt mismatch: ${JSON.stringify(receipt)}`);
  }

  console.log(
    JSON.stringify({
      schemaVersion: 1,
      fixtureId: FIXTURE.fixtureId,
      freshInstall: true,
      artifactDigestAlgorithm: "sha256",
      artifactSha256,
      artifactProfile: profile,
      tamperedCandidate: {
        artifactSha256: tamperedSha256,
        ...tamperedRejection,
      },
      receipt,
    }),
  );
  writeFailedTrailer(TOOL, 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  writeFailedTrailer(TOOL, 1);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
