import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigSchema } from "../config/schema.js";
import {
  inspectContinuityConfigDependencies,
  prepareContinuityConfigCapture,
} from "./config-dependencies.js";

const tempDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-continuity-config-"));
  tempDirs.push(dir);
  return dir;
}

function inspect(params: {
  dir: string;
  raw: string;
  extensionMetadataComplete?: boolean;
  allowedRoots?: readonly string[];
}) {
  return inspectContinuityConfigDependencies({
    configPath: path.join(params.dir, "openclaw.json"),
    raw: params.raw,
    uiHints: buildConfigSchema().uiHints,
    extensionMetadataComplete: params.extensionMetadataComplete ?? true,
    allowedRoots: params.allowedRoots,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("continuity config dependency classifier", () => {
  it("preserves SecretRefs and environment placeholders as external dependencies", () => {
    const dir = makeConfigDir();

    expect(
      inspect({
        dir,
        raw: JSON.stringify({
          gateway: {
            auth: {
              token: { source: "file", provider: "vault", id: "/gateway/token" },
              password: "${OPENCLAW_GATEWAY_PASSWORD}",
            },
          },
        }),
      }),
    ).toEqual({
      eligible: true,
      blockers: [],
      evidence: {
        includeFileCount: 0,
        secretReferenceCount: 2,
        secretReferencesBySource: {
          env: 1,
          file: 1,
          exec: 0,
        },
        literalSensitiveValueCount: 0,
      },
    });
  });

  it("walks nested guarded includes without resolving referenced secret bytes", () => {
    const dir = makeConfigDir();
    fs.writeFileSync(
      path.join(dir, "gateway.json5"),
      `{
        gateway: {
          $include: "./gateway-auth.json5",
        },
      }`,
    );
    fs.writeFileSync(
      path.join(dir, "gateway-auth.json5"),
      `{
        auth: {
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      }`,
    );

    const result = inspect({
      dir,
      raw: `{ $include: "./gateway.json5" }`,
    });

    expect(result).toEqual({
      eligible: true,
      blockers: [],
      evidence: {
        includeFileCount: 2,
        secretReferenceCount: 1,
        secretReferencesBySource: {
          env: 0,
          file: 0,
          exec: 1,
        },
        literalSensitiveValueCount: 0,
      },
    });
  });

  it("returns the guarded include closure only to the capture preparation", () => {
    const dir = makeConfigDir();
    const includedPath = path.join(dir, "gateway.json5");
    fs.writeFileSync(includedPath, `{ gateway: { port: 18789 } }`);

    const prepared = prepareContinuityConfigCapture({
      configPath: path.join(dir, "openclaw.json"),
      raw: `{ $include: "./gateway.json5" }`,
      uiHints: buildConfigSchema().uiHints,
      extensionMetadataComplete: true,
    });

    expect(prepared.includedFiles).toEqual([includedPath]);
    expect(prepared.assessment.evidence.includeFileCount).toBe(1);
    expect(JSON.stringify(prepared.assessment)).not.toContain(includedPath);
  });

  it("blocks literal sensitive values without returning their paths or bytes", () => {
    const dir = makeConfigDir();

    expect(
      inspect({
        dir,
        raw: JSON.stringify({
          gateway: {
            auth: {
              token: "literal-token-value",
              password: "literal-password-value",
            },
          },
        }),
      }),
    ).toEqual({
      eligible: false,
      blockers: [{ code: "continuity.config.literal_sensitive_values", count: 2 }],
      evidence: {
        includeFileCount: 0,
        secretReferenceCount: 0,
        secretReferencesBySource: {
          env: 0,
          file: 0,
          exec: 0,
        },
        literalSensitiveValueCount: 2,
      },
    });
  });

  it("rejects unsupported environment placeholder syntax at sensitive paths", () => {
    const dir = makeConfigDir();

    expect(
      inspect({
        dir,
        raw: `{ gateway: { auth: { token: "\${lowercase_is_not_supported}" } } }`,
      }).blockers,
    ).toEqual([{ code: "continuity.config.literal_sensitive_values", count: 1 }]);
  });

  it("rejects include paths that escape through symlinks", () => {
    const dir = makeConfigDir();
    const outsideDir = makeConfigDir();
    fs.writeFileSync(path.join(outsideDir, "secret.json5"), `{ gateway: { port: 18789 } }`);
    fs.symlinkSync(outsideDir, path.join(dir, "linked"));

    expect(inspect({ dir, raw: `{ $include: "./linked/secret.json5" }` }).blockers).toEqual([
      { code: "continuity.config.include_unresolved", count: 1 },
    ]);
  });

  it("fails closed when extension sensitivity metadata is incomplete", () => {
    const dir = makeConfigDir();

    expect(
      inspect({
        dir,
        raw: JSON.stringify({ plugins: { entries: { example: { config: {} } } } }),
        extensionMetadataComplete: false,
      }).blockers,
    ).toEqual([{ code: "continuity.config.extension_metadata_incomplete", count: 1 }]);
  });

  it.each([
    {
      name: "missing include",
      raw: `{ $include: "./missing.json5" }`,
      allowedRoots: undefined,
    },
    {
      name: "include escape",
      raw: `{ $include: "../outside.json5" }`,
      allowedRoots: [],
    },
  ])("fails closed on $name", ({ raw, allowedRoots }) => {
    const dir = makeConfigDir();

    expect(inspect({ dir, raw, allowedRoots })).toEqual({
      eligible: false,
      blockers: [{ code: "continuity.config.include_unresolved", count: 1 }],
      evidence: {
        includeFileCount: 0,
        secretReferenceCount: 0,
        secretReferencesBySource: {
          env: 0,
          file: 0,
          exec: 0,
        },
        literalSensitiveValueCount: 0,
      },
    });
  });

  it("fails closed on malformed config", () => {
    const dir = makeConfigDir();

    expect(inspect({ dir, raw: "{ gateway: " })).toEqual({
      eligible: false,
      blockers: [{ code: "continuity.config.malformed", count: 1 }],
      evidence: {
        includeFileCount: 0,
        secretReferenceCount: 0,
        secretReferencesBySource: {
          env: 0,
          file: 0,
          exec: 0,
        },
        literalSensitiveValueCount: 0,
      },
    });
  });

  it("does not expose dependency identifiers in serialized evidence", () => {
    const dir = makeConfigDir();
    const result = inspect({ dir, raw: `{ gateway: { auth: { token: "$SECRET_ID" } } }` });
    expect(JSON.stringify(result)).not.toContain("SECRET_ID");
  });
});
