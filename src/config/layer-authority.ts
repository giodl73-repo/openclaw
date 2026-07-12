export type ConfigLayerControl = "exact" | "allow-set-ceiling" | "deny-set-floor";

export type ConfigLayerAuthorityValue = {
  valid: true;
  control: ConfigLayerControl;
  value: unknown;
};

export type ConfigLayerBoundComparison =
  | { accepted: true; value: string[]; tightened: boolean }
  | { accepted: false; invalid: boolean };

const CONTROL_BY_PATH = new Map<string, Exclude<ConfigLayerControl, "exact">>([
  ["tools.allow", "allow-set-ceiling"],
  ["tools.deny", "deny-set-floor"],
]);

function canonicalStringSet(
  value: unknown,
  control: Exclude<ConfigLayerControl, "exact">,
): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const entries = value as string[];
  const literal = /^[a-z0-9_]+$/;
  if (
    entries.some(
      (entry) =>
        !literal.test(entry) ||
        entry === "bash" ||
        (control === "allow-set-ceiling" && entry === "write"),
    )
  ) {
    return undefined;
  }
  return [...new Set(entries)].toSorted();
}

export function prepareConfigLayerAuthorityValue(
  path: string,
  value: unknown,
): ConfigLayerAuthorityValue {
  const control = CONTROL_BY_PATH.get(path);
  if (!control) {
    return { valid: true, control: "exact", value: structuredClone(value) };
  }
  const canonical = canonicalStringSet(value, control);
  if (!canonical) {
    return { valid: true, control: "exact", value: structuredClone(value) };
  }
  return { valid: true, control, value: canonical };
}

export function compareConfigLayerBound(params: {
  control: Exclude<ConfigLayerControl, "exact">;
  inherited: unknown;
  candidate: unknown;
}): ConfigLayerBoundComparison {
  const inherited = canonicalStringSet(params.inherited, params.control);
  const candidate = canonicalStringSet(params.candidate, params.control);
  if (!inherited || !candidate) {
    return { accepted: false, invalid: false };
  }

  const inheritedSet = new Set(inherited);
  const candidateSet = new Set(candidate);
  const accepted =
    params.control === "allow-set-ceiling"
      ? inherited.length === 0
        ? true
        : candidate.length > 0 && candidate.every((entry) => inheritedSet.has(entry))
      : inherited.every((entry) => candidateSet.has(entry));

  if (!accepted) {
    return { accepted: false, invalid: false };
  }
  return {
    accepted: true,
    value: candidate,
    tightened:
      candidate.length !== inherited.length ||
      candidate.some((entry, index) => entry !== inherited[index]),
  };
}
