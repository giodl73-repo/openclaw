import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { runDoctorLintChecks } from "../../../../src/flows/doctor-lint-flow.js";
import { runDoctorHealthRepairs } from "../../../../src/flows/doctor-repair-flow.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
} from "../../../../src/flows/health-check-registry.js";
import type {
  HealthCheckContext,
  HealthRepairContext,
} from "../../../../src/flows/health-checks.js";
import { policyDocumentHash } from "../policy-state.js";
import { registerPolicyDoctorChecks, resetPolicyDoctorChecksForTest } from "./register.js";

let workspaceDir: string;

function cfgWithPolicy(settings: Record<string, unknown> = {}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: true,
          config: { enabled: true, ...settings },
        },
      },
    },
  };
}

function ctx(configPath: string, cfg: OpenClawConfig = {}): HealthCheckContext {
  return {
    mode: "lint",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
    cwd: workspaceDir,
    configPath,
  };
}

function repairCtx(configPath: string, cfg: OpenClawConfig = {}): HealthRepairContext {
  return {
    ...ctx(configPath, cfg),
    mode: "fix",
  };
}

describe("registerPolicyDoctorChecks", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    clearHealthChecksForTest();
    resetPolicyDoctorChecksForTest();
  });

  it("registers policy health checks once", () => {
    registerPolicyDoctorChecks();
    registerPolicyDoctorChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual([
      "policy/policy-jsonc-missing",
      "policy/policy-hash-mismatch",
      "policy/channels-denied-provider",
      "policy/models-denied-provider",
      "policy/models-unapproved-provider",
      "policy/network-private-access-enabled",
      "policy/tools-missing-risk-level",
      "policy/tools-missing-sensitivity-token",
      "policy/tools-unknown-sensitivity-token",
    ]);
  });

  it("reports a missing policy file when the policy extension is enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-missing",
        severity: "warning",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("does not report a missing policy file when policy is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy({ enabled: false })));

    expect(result.findings).toEqual([]);
  });

  it("reports a policy hash mismatch when expectedHash is configured", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: "sha256:not-the-policy" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-hash-mismatch",
        severity: "error",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("accepts a policy file that matches the configured expectedHash", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: policyDocumentHash(policy) })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports configured channels denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [
              {
                id: "no-telegram",
                when: { provider: "telegram" },
                reason: "Telegram is not approved for this workspace.",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/channels-denied-provider",
        severity: "error",
        path: "openclaw config",
        ocPath: "oc://openclaw.config/channels/telegram",
        target: "oc://openclaw.config/channels/telegram",
        requirement: "oc://policy.jsonc/channels/denyRules/#0",
        fixHint: "Telegram is not approved for this workspace.",
      }),
    ]);
  });

  it("repairs denied enabled channels by disabling them when workspace repairs are enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorHealthRepairs(repairCtx(configPath, cfg), {
      checks: listHealthChecks().filter((entry) => entry.id === "policy/channels-denied-provider"),
    });

    expect(result.changes).toEqual(["Disabled channels.telegram.enabled for policy conformance."]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.channels?.telegram).toEqual({ enabled: false });
  });

  it("does not repair denied channels without workspace repair opt-in", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: false }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorHealthRepairs(repairCtx(configPath, cfg), {
      checks: listHealthChecks().filter((entry) => entry.id === "policy/channels-denied-provider"),
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
      "policy/channels-denied-provider repair skipped: workspace repairs are disabled",
    ]);
    expect(result.config.channels?.telegram).toEqual({ enabled: true });
  });

  it("does not report denied providers for disabled channels", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: false } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [
              {
                id: "no-telegram",
                when: { provider: "telegram" },
                reason: "Telegram is not approved for this workspace.",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    await expect(runDoctorLintChecks(ctx(configPath, cfg))).resolves.toMatchObject({
      findings: [],
    });
  });

  it("does not run channel checks for an empty category namespace", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({ channels: {} }), "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports governed tools missing risk and sensitivity metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { requireRisk: true, requireSensitivity: true } } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-missing-risk-level",
        severity: "error",
        path: "TOOLS.md",
        ocPath: "oc://TOOLS.md/tools/deploy",
      }),
      expect.objectContaining({
        checkId: "policy/tools-missing-sensitivity-token",
        severity: "error",
        path: "TOOLS.md",
        ocPath: "oc://TOOLS.md/tools/deploy",
      }),
    ]);
  });

  it("reports model providers denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: "openrouter/openai/gpt-5.5",
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { deny: ["openrouter"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/openrouter",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/model",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
    ]);
  });

  it("reports model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4.7"],
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports configured model providers outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          anthropic: {},
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/anthropic",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports non-default agent model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          imageModel: "openai/gpt-5.5",
          subagents: {
            model: "anthropic/claude-sonnet-4.7",
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/subagents/model",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports per-agent model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          {
            id: "research",
            model: { primary: "openrouter/openai/gpt-5.5" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { deny: ["openrouter"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/list/#0/model/primary",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
    ]);
  });

  it("does not enable tool metadata checks from a model-only policy block", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy({ enabled: undefined })));

    expect(result.findings).toEqual([]);
  });

  it("reports private-network SSRF settings denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      browser: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowIpv6UniqueLocalRange: true,
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        network: {
          privateNetwork: { allow: false },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
    ]);
  });

  it("allows private-network SSRF settings when policy permits them", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        network: {
          privateNetwork: { allow: true },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not enable model checks from a network-only policy block", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ enabled: undefined }),
      models: {
        providers: {
          openrouter: {},
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        network: {
          privateNetwork: { allow: false },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports unknown governed tool sensitivity metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { requireSensitivity: true } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:secret\n",
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-unknown-sensitivity-token",
        severity: "error",
        path: "TOOLS.md",
        ocPath: "oc://TOOLS.md/tools/deploy",
      }),
    ]);
  });
});
