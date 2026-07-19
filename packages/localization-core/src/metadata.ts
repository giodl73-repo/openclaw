import { getLocaleRegistration, matchExactOpenClawLocale } from "./locale-registry.js";

export type LocalizedText = {
  default: string;
  localizations?: Readonly<Record<string, string>>;
};

export type LocalizedTextInput = string | LocalizedText;
export type LocalizedTextScope = "product" | "external";

export type NormalizedLocalizedText = Readonly<{
  default: string;
  localizations: Readonly<Record<string, string>>;
}>;

export type LocalizedTextValidationIssue = Readonly<{
  code:
    | "invalid-default"
    | "invalid-localizations"
    | "invalid-locale"
    | "duplicate-locale"
    | "invalid-translation"
    | "too-many-localizations"
    | "aggregate-size-exceeded"
    | "conflicting-sources";
  locale?: string;
  detail: string;
}>;

export type LocalizedTextNormalizationResult = Readonly<{
  value: NormalizedLocalizedText | null;
  issues: readonly LocalizedTextValidationIssue[];
}>;

// Build C0/C1 ranges at runtime so no-control-regex does not reject the
// intentional display-control validation pattern. Tab, LF, and CR remain valid.
const FORBIDDEN_DISPLAY_CONTROL_RANGE =
  `${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}` +
  `${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}` +
  `${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}` +
  `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}` +
  "\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f";
const FORBIDDEN_DISPLAY_CONTROL_PATTERN = new RegExp(`[${FORBIDDEN_DISPLAY_CONTROL_RANGE}]`, "u");

export function normalizeLocalizedText(
  input: LocalizedTextInput,
  options?: {
    scope?: LocalizedTextScope;
    legacyLocalizations?: Readonly<Record<string, string>>;
    maxLength?: number;
    maxLocalizations?: number;
    maxAggregateLength?: number;
  },
): LocalizedTextNormalizationResult {
  const scope = options?.scope ?? "product";
  const maxLength = options?.maxLength ?? 2_048;
  const maxLocalizations = options?.maxLocalizations ?? 64;
  const maxAggregateLength = options?.maxAggregateLength ?? 65_536;
  const issues: LocalizedTextValidationIssue[] = [];
  const objectInput = typeof input === "string" ? null : input;
  const defaultText = (typeof input === "string" ? input : input.default).trim();
  const objectLocalizations = objectInput?.localizations;
  const legacyLocalizations = options?.legacyLocalizations;

  if (!defaultText || defaultText.length > maxLength || hasForbiddenDisplayControl(defaultText)) {
    issues.push({
      code: "invalid-default",
      detail: `Default metadata must be non-empty, at most ${maxLength} characters, and free of display controls.`,
    });
  }

  if (
    objectLocalizations !== undefined &&
    legacyLocalizations !== undefined &&
    Object.keys(legacyLocalizations).length > 0
  ) {
    issues.push({
      code: "conflicting-sources",
      detail: "Localized metadata cannot define both object and legacy localization maps.",
    });
  }

  const rawLocalizations = objectLocalizations ?? legacyLocalizations ?? {};
  if (!isStringRecord(rawLocalizations)) {
    issues.push({
      code: "invalid-localizations",
      detail: "Localized metadata localizations must be a string-to-string object.",
    });
    return freezeResult(null, issues);
  }

  const entries = Object.entries(rawLocalizations);
  if (entries.length > maxLocalizations) {
    issues.push({
      code: "too-many-localizations",
      detail: `Localized metadata supports at most ${maxLocalizations} locale entries.`,
    });
  }

  const normalizedLocalizations = new Map<string, string>();
  let aggregateLength = defaultText.length;
  for (const [rawLocale, rawTranslation] of entries) {
    const locale = normalizeMetadataLocale(rawLocale, scope);
    if (!locale) {
      issues.push({
        code: "invalid-locale",
        locale: rawLocale,
        detail:
          scope === "product"
            ? "Core and bundled metadata locales must resolve through the OpenClaw product registry."
            : "External metadata locales must be valid canonicalizable BCP 47 tags.",
      });
      continue;
    }

    const translation = rawTranslation.trim();
    aggregateLength += translation.length;
    if (!translation || translation.length > maxLength || hasForbiddenDisplayControl(translation)) {
      issues.push({
        code: "invalid-translation",
        locale: rawLocale,
        detail: `Localized metadata must be non-empty, at most ${maxLength} characters, and free of display controls.`,
      });
      continue;
    }

    const existing = normalizedLocalizations.get(locale);
    if (existing !== undefined && existing !== translation) {
      issues.push({
        code: "duplicate-locale",
        locale: rawLocale,
        detail: `Multiple locale keys normalize to ${locale} with different text.`,
      });
      continue;
    }
    normalizedLocalizations.set(locale, translation);
  }

  if (aggregateLength > maxAggregateLength) {
    issues.push({
      code: "aggregate-size-exceeded",
      detail: `Localized metadata exceeds the ${maxAggregateLength}-character aggregate limit.`,
    });
  }

  if (issues.length > 0) {
    return freezeResult(null, issues);
  }

  const localizations = Object.freeze(
    Object.fromEntries(
      [...normalizedLocalizations.entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
  return freezeResult(Object.freeze({ default: defaultText, localizations }), []);
}

export function resolveLocalizedText(
  metadata: NormalizedLocalizedText,
  locale: string | null | undefined,
  scope: LocalizedTextScope = "product",
): string {
  if (scope === "product") {
    const matched = matchExactOpenClawLocale(locale);
    if (!matched) {
      return metadata.default;
    }
    for (const candidate of [matched, ...getLocaleRegistration(matched).fallback]) {
      const translation = metadata.localizations[candidate];
      if (translation) {
        return translation;
      }
    }
    return metadata.default;
  }

  const normalized = normalizeExternalLocaleToken(locale);
  if (!normalized) {
    return metadata.default;
  }
  const segments = normalized.split("-");
  while (segments.length > 0) {
    const translation = metadata.localizations[segments.join("-")];
    if (translation) {
      return translation;
    }
    segments.pop();
  }
  return metadata.default;
}

function normalizeMetadataLocale(raw: string, scope: LocalizedTextScope): string | null {
  if (scope === "product") {
    return matchExactOpenClawLocale(raw);
  }
  return normalizeExternalLocaleToken(raw);
}

function normalizeExternalLocaleToken(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function hasForbiddenDisplayControl(value: string): boolean {
  return FORBIDDEN_DISPLAY_CONTROL_PATTERN.test(value);
}

function freezeResult(
  value: NormalizedLocalizedText | null,
  issues: LocalizedTextValidationIssue[],
): LocalizedTextNormalizationResult {
  return Object.freeze({
    value,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}
