export type CliCatalogRisk = "low" | "medium" | "high";
export type CliCatalogEffectMode = "read" | "mutating" | "mixed";
export type CliCatalogVisibility = "docs" | "prompt" | "audit" | "operator" | "policy";
export type CliCatalogExposureTier = "public" | "internal";

export type CommandEffectProfile = {
  readonly effectMode: CliCatalogEffectMode;
  readonly confirmationRequired?: boolean;
  readonly risk?: CliCatalogRisk;
  readonly commandHints?: readonly string[];
};

export type CatalogExposure = {
  readonly tier?: CliCatalogExposureTier;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeCommandEffectProfile(value: unknown): CommandEffectProfile | undefined {
  const record = asRecord(value);
  if (
    !record ||
    (record.effectMode !== "read" &&
      record.effectMode !== "mutating" &&
      record.effectMode !== "mixed") ||
    (record.confirmationRequired !== undefined &&
      typeof record.confirmationRequired !== "boolean") ||
    (record.risk !== undefined &&
      record.risk !== "low" &&
      record.risk !== "medium" &&
      record.risk !== "high") ||
    (record.commandHints !== undefined &&
      (!Array.isArray(record.commandHints) ||
        record.commandHints.some((hint) => typeof hint !== "string")))
  ) {
    return undefined;
  }
  const commandHints = Array.isArray(record.commandHints)
    ? record.commandHints.map((hint) => hint.trim()).filter(Boolean)
    : undefined;
  return {
    effectMode: record.effectMode,
    ...(typeof record.confirmationRequired === "boolean"
      ? { confirmationRequired: record.confirmationRequired }
      : {}),
    ...(record.risk === "low" || record.risk === "medium" || record.risk === "high"
      ? { risk: record.risk }
      : {}),
    ...(commandHints ? { commandHints } : {}),
  };
}

export function normalizeCatalogExposure(value: unknown): CatalogExposure | undefined {
  const record = asRecord(value);
  if (
    !record ||
    (record.tier !== undefined && record.tier !== "public" && record.tier !== "internal")
  ) {
    return undefined;
  }
  return record.tier === "public" || record.tier === "internal" ? { tier: record.tier } : {};
}
