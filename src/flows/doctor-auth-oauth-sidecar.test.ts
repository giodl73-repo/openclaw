import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { doctorAuthOAuthSidecarTesting } from "../commands/doctor-auth-oauth-sidecar.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const states: OpenClawTestState[] = [];

async function makeTestState(seed: string): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-health-oauth-sidecar-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  return state;
}

function encryptLegacySidecarMaterial(params: {
  ref: { source: "openclaw-credentials"; provider: "openai-codex"; id: string };
  profileId: string;
  provider: string;
  seed: string;
  material: Record<string, string>;
}) {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    doctorAuthOAuthSidecarTesting.buildLegacyOAuthSecretKey(params.seed),
    iv,
  );
  cipher.setAAD(
    doctorAuthOAuthSidecarTesting.buildLegacyOAuthSecretAad({
      ref: params.ref,
      profileId: params.profileId,
      provider: params.provider,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(params.material), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

describe("doctor OAuth sidecar repair", () => {
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    for (const state of states.splice(0)) {
      await state.cleanup();
    }
  });

  it("migrates legacy OAuth sidecars through the structured health check", async () => {
    const seed = "structured-oauth-sidecar-seed";
    const state = await makeTestState(seed);
    const profileId = "openai-codex:default";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "0123456789abcdef0123456789abcdef",
    };
    const authPath = await state.writeAuthProfiles({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai-codex",
          expires: 1777777777000,
          oauthRef: ref,
        },
      },
    });
    const sidecarPath = await state.writeJson(
      path.join("credentials", "auth-profiles", `${ref.id}.json`),
      {
        version: 1,
        profileId,
        provider: "openai-codex",
        encrypted: encryptLegacySidecarMaterial({
          ref,
          profileId,
          provider: "openai-codex",
          seed,
          material: {
            access: "access-token",
            refresh: "refresh-token",
          },
        }),
      },
    );
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/auth-profiles/oauth-sidecar",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const cfg = {};

    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles/oauth-sidecar",
        message: expect.stringContaining("has legacy sidecar-backed Codex OAuth profiles"),
        path: authPath,
      }),
    );

    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg,
          doctor: {
            confirm: vi.fn(async () => true),
          },
        },
        findings ?? [],
      ),
    ).resolves.toMatchObject({
      changes: [expect.stringContaining("to inline credentials")],
      warnings: [],
    });

    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg,
        },
        { findings },
      ),
    ).resolves.toEqual([]);

    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai-codex",
          expires: 1777777777000,
          access: "access-token",
          refresh: "refresh-token",
        },
      },
    });
  });
});
