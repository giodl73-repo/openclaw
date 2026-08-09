import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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
  throw new Error("Cargo is required for the Rust Gateway live admission proof");
}

let cargo;
try {
  cargo = resolveCargo();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "test/vitest/vitest.e2e.config.ts",
    "src/gateway/rust-gateway-live-admission.e2e.test.ts",
  ],
  {
    env: { ...process.env, CARGO: cargo },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
