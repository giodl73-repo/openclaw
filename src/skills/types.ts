// Skill types expose the shared skill contracts used by discovery, loading, and runtime flows.
import type { Skill } from "./loading/skill-contract.js";

export type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type OpenClawSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
};

export type SkillInvocationPolicy = {
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

export type SkillExecutionHints = {
  outcomes?: string[];
  usesSkills?: string[];
  isolation?: "shared" | "preferred" | "required";
};

type SkillCommandDispatchSpec = {
  kind: "tool";
  /** Name of the tool to invoke (AnyAgentTool.name). */
  toolName: string;
  /**
   * How to forward user-provided args to the tool.
   * - raw: forward the raw args string (no core parsing).
   */
  argMode?: "raw";
};

export type SkillTelemetrySource = "bundled" | "unknown" | "workspace";

export type SkillOrchestrationBudgetRef = {
  /** Root child session that owns the shared budget counter. */
  ownerSessionKey: string;
  /** Root agent run covered by the budget. */
  rootRunId: string;
};

/** Trusted identity for one explicit, user-requested skill invocation. */
export type ExplicitSkillInvocation = {
  invocationId: string;
  commandName: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
  skillDigest?: string;
  executionHints?: SkillExecutionHints;
  /** Invocation that requested this child skill run. */
  parentInvocationId?: string;
  /** Agent run that requested this child skill run. */
  parentRunId?: string;
  /** Trusted shared-budget owner inherited by descendant skill runs. */
  orchestrationBudget?: SkillOrchestrationBudgetRef;
};

export type SkillUsagePath = {
  /** Path visible to the tool runtime when it reads SKILL.md. */
  readPath: string;
  /** Canonical source SKILL.md path used as the lifecycle identity. */
  skillFile: string;
  skillName: string;
  skillSource: SkillTelemetrySource;
};

export type SkillCommandSpec = {
  name: string;
  /** Canonical SKILL.md path for file-scoped usage accounting. */
  skillFile?: string;
  skillName: string;
  description: string;
  /** Bounded source label used for diagnostics. */
  skillSource?: SkillTelemetrySource;
  /** Exact SHA-256 identity of the loaded SKILL.md content. */
  skillDigest?: string;
  /** Portable author hints consumed by managed OpenClaw invocation. */
  executionHints?: SkillExecutionHints;
  /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  /** Optional deterministic dispatch behavior for this command. */
  dispatch?: SkillCommandDispatchSpec;
  /** Native prompt template used by Claude-bundle command markdown files. */
  promptTemplate?: string;
  /** Source markdown path for bundle-backed commands. */
  sourceFilePath?: string;
};

export type SkillsInstallPreferences = {
  preferBrew: boolean;
  nodeManager: "npm" | "pnpm" | "yarn" | "bun";
};

export type ParsedSkillFrontmatter = Record<string, string>;

type SkillExposure = {
  includeInRuntimeRegistry: boolean;
  includeInAvailableSkillsPrompt: boolean;
  userInvocable: boolean;
};

export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata?: OpenClawSkillMetadata;
  invocation?: SkillInvocationPolicy;
  exposure?: SkillExposure;
  syncSourceDir?: string;
  syncDirName?: string;
  disableCommandDispatch?: boolean;
};

export type SkillEligibilityContext = {
  nodeSkills?: {
    canExec: boolean;
    node?: string;
  };
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

export const WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION = 2;

export type SkillSnapshot = {
  prompt: string;
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
    skillDigest?: string;
    executionHints?: SkillExecutionHints;
  }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  /** Effective node-exec eligibility used to select connected node-hosted skills. */
  nodeSkillsEligibility?: SkillEligibilityContext["nodeSkills"];
  resolvedSkills?: Skill[];
  version?: number;
  promptFormatVersion?: number;
};
