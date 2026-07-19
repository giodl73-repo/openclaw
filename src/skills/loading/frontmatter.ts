// Frontmatter helpers parse skill metadata from SKILL.md files.
import {
  normalizeLocalizedText,
  type LocalizedTextInput,
  type NormalizedLocalizedText,
} from "@openclaw/localization-core";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { parseFrontmatterBlockResult } from "../../../packages/markdown-core/src/frontmatter.js";
import { validateRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import {
  applyOpenClawManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseOpenClawManifestInstallBase,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "../../shared/frontmatter.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
} from "../types.js";
import type { Skill } from "./skill-contract.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  const parsed = parseFrontmatterBlockResult(content);
  const issue = parsed.issues[0];
  if (issue) {
    throw new Error(`invalid frontmatter: ${issue.code}: ${issue.message}`);
  }
  return parsed.frontmatter;
}

const BREW_FORMULA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
const GO_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*(?:@[A-Za-z0-9][A-Za-z0-9._~+\-/]*)?$/;
const UV_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]=<>!~+,]*$/;

type SkillPresentationMetadata = NonNullable<OpenClawSkillMetadata["presentation"]>;

function normalizeSafeBrewFormula(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const formula = raw.trim();
  if (!formula || formula.startsWith("-") || formula.includes("\\") || formula.includes("..")) {
    return undefined;
  }
  if (!BREW_FORMULA_PATTERN.test(formula)) {
    return undefined;
  }
  return formula;
}

function normalizeSafeNpmSpec(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const spec = raw.trim();
  if (!spec || spec.startsWith("-")) {
    return undefined;
  }
  if (validateRegistryNpmSpec(spec) !== null) {
    return undefined;
  }
  return spec;
}

function normalizeSafeGoModule(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const moduleSpec = raw.trim();
  if (
    !moduleSpec ||
    moduleSpec.startsWith("-") ||
    moduleSpec.includes("\\") ||
    moduleSpec.includes("://")
  ) {
    return undefined;
  }
  if (!GO_MODULE_PATTERN.test(moduleSpec)) {
    return undefined;
  }
  return moduleSpec;
}

function normalizeSafeUvPackage(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const pkg = raw.trim();
  if (!pkg || pkg.startsWith("-") || pkg.includes("\\") || pkg.includes("://")) {
    return undefined;
  }
  if (!UV_PACKAGE_PATTERN.test(pkg)) {
    return undefined;
  }
  return pkg;
}

function normalizeSafeDownloadUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value || /\s/.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  const parsed = parseOpenClawManifestInstallBase(input, ["brew", "node", "go", "uv", "download"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyOpenClawManifestInstallCommonFields<SkillInstallSpec>(
    {
      kind: parsed.kind as SkillInstallSpec["kind"],
    },
    parsed,
  );
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  const formula = normalizeSafeBrewFormula(raw.formula);
  if (formula) {
    spec.formula = formula;
  }
  const cask = normalizeSafeBrewFormula(raw.cask);
  if (!spec.formula && cask) {
    spec.formula = cask;
  }
  if (spec.kind === "node") {
    const pkg = normalizeSafeNpmSpec(raw.package);
    if (pkg) {
      spec.package = pkg;
    }
  } else if (spec.kind === "uv") {
    const pkg = normalizeSafeUvPackage(raw.package);
    if (pkg) {
      spec.package = pkg;
    }
  }
  const moduleSpec = normalizeSafeGoModule(raw.module);
  if (moduleSpec) {
    spec.module = moduleSpec;
  }
  const downloadUrl = normalizeSafeDownloadUrl(raw.url);
  if (downloadUrl) {
    spec.url = downloadUrl;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  if (spec.kind === "brew" && !spec.formula) {
    return undefined;
  }
  if (spec.kind === "node" && !spec.package) {
    return undefined;
  }
  if (spec.kind === "go" && !spec.module) {
    return undefined;
  }
  if (spec.kind === "uv" && !spec.package) {
    return undefined;
  }
  if (spec.kind === "download" && !spec.url) {
    return undefined;
  }

  return spec;
}

function parseLocalizedPresentationField(
  value: unknown,
  field: "displayName" | "description",
): { value?: NormalizedLocalizedText; issue?: string } {
  let input: LocalizedTextInput;
  if (typeof value === "string") {
    input = value;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const localizations = candidate.localizations;
    if (
      typeof candidate.default !== "string" ||
      (localizations !== undefined &&
        (!localizations ||
          typeof localizations !== "object" ||
          Array.isArray(localizations) ||
          !Object.values(localizations).every((entry) => typeof entry === "string")))
    ) {
      return { issue: `${field} must be a string or localized text object` };
    }
    input = {
      default: candidate.default,
      ...(localizations
        ? { localizations: Object.fromEntries(Object.entries(localizations)) }
        : {}),
    };
  } else {
    return { issue: `${field} must be a string or localized text object` };
  }
  const result = normalizeLocalizedText(input, {
    scope: "external",
    maxLength: field === "displayName" ? 120 : 2_000,
    maxLocalizations: 32,
    maxAggregateLength: 16_384,
  });
  if (!result.value) {
    return {
      issue: result.issues.map((entry) => `${entry.code}: ${entry.detail}`).join(" "),
    };
  }
  return { value: result.value };
}

function resolveSkillPresentation(metadataObj: Record<string, unknown>): {
  presentation?: SkillPresentationMetadata;
  issues?: readonly string[];
} {
  const raw = metadataObj.presentation;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { issues: ["presentation must be an object"] };
  }

  const presentation: SkillPresentationMetadata = {};
  const issues: string[] = [];
  for (const field of ["displayName", "description"] as const) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined) {
      continue;
    }
    const parsed = parseLocalizedPresentationField(value, field);
    if (parsed.value) {
      presentation[field] = parsed.value;
    } else if (parsed.issue) {
      issues.push(`${field}: ${parsed.issue}`);
    }
  }
  return {
    ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
    ...(issues.length > 0 ? { issues: Object.freeze(issues) } : {}),
  };
}

export function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveOpenClawManifestRequires(metadataObj);
  const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveOpenClawManifestOs(metadataObj);
  const presentation = resolveSkillPresentation(metadataObj);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: readStringValue(metadataObj.emoji),
    homepage: readStringValue(metadataObj.homepage),
    presentation: presentation.presentation,
    presentationIssues: presentation.issues,
    skillKey: readStringValue(metadataObj.skillKey),
    primaryEnv: readStringValue(metadataObj.primaryEnv),
    os: osRaw.length > 0 ? osRaw : undefined,
    requires,
    install: install.length > 0 ? install : undefined,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
