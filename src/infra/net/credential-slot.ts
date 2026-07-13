export const CREDENTIAL_SLOT_VERSION = "credential-slot/v1" as const;
export const CREDENTIAL_SLOT_RESOLVER_VERSION = "credential-slot-resolver/v1" as const;

export type CredentialSlotDefinitionV1 = {
  version: typeof CREDENTIAL_SLOT_VERSION;
  slotId: string;
  placement: "header";
  headerName: string;
  allowedOrigins: string[];
  required: boolean;
  resolverId: string;
};

export type CredentialSlotValueV1 = {
  value: string;
  expiresAtMs?: number;
};

export type CredentialSlotResolverV1 = {
  version: typeof CREDENTIAL_SLOT_RESOLVER_VERSION;
  resolverId: string;
  slotId: string;
  placement: "header";
  headerName: string;
  allowedOrigins: string[];
  resolve: (params: {
    slotId: string;
    origin: string;
    signal?: AbortSignal;
  }) => Promise<CredentialSlotValueV1 | null>;
};

export type CredentialSlotFailureCode =
  | "invalid-definition"
  | "duplicate-slot"
  | "duplicate-resolver"
  | "ambiguous-header"
  | "missing-resolver"
  | "incompatible-resolver"
  | "unknown-slot"
  | "duplicate-reference"
  | "origin-denied"
  | "header-conflict"
  | "credential-unavailable"
  | "credential-expired";

export class CredentialSlotError extends Error {
  readonly code: CredentialSlotFailureCode;
  readonly slotId?: string;

  constructor(code: CredentialSlotFailureCode, message: string, slotId?: string) {
    super(message);
    this.name = "CredentialSlotError";
    this.code = code;
    this.slotId = slotId;
  }
}

export type CredentialSlotReadinessV1 = {
  slotId: string;
  resolverId: string;
  version: typeof CREDENTIAL_SLOT_VERSION;
  resolverVersion: typeof CREDENTIAL_SLOT_RESOLVER_VERSION;
  placement: "header";
  headerName: string;
  allowedOrigins: string[];
  required: boolean;
};

type PreparedCredentialSlot = {
  definition: CredentialSlotDefinitionV1;
  resolver: CredentialSlotResolverV1;
};

export type PreparedCredentialSlotBindingsV1 = {
  apply: (params: {
    slotRefs: string[];
    url: string;
    init: RequestInit;
    signal?: AbortSignal;
    now?: () => number;
  }) => Promise<RequestInit>;
  readiness: () => CredentialSlotReadinessV1[];
};

function normalizeId(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHeaderName(value: string): string {
  const headerName = typeof value === "string" ? value.trim().toLowerCase() : "";
  try {
    const validationHeaders = new Headers();
    validationHeaders.set(headerName, "validation");
  } catch {
    throw new CredentialSlotError("invalid-definition", "Credential slot header name is invalid");
  }
  return headerName;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CredentialSlotError("invalid-definition", "Credential slot origin is invalid");
  }
  if (parsed.origin === "null" || parsed.toString() !== `${parsed.origin}/`) {
    throw new CredentialSlotError(
      "invalid-definition",
      "Credential slot origins must be exact origins",
    );
  }
  return parsed.origin;
}

function normalizeOrigins(origins: string[]): string[] {
  if (!Array.isArray(origins)) {
    throw new CredentialSlotError("invalid-definition", "Credential slot origins are invalid");
  }
  return [...new Set(origins.map(normalizeOrigin))].toSorted();
}

function normalizeDefinition(definition: CredentialSlotDefinitionV1): CredentialSlotDefinitionV1 {
  if (definition.version !== CREDENTIAL_SLOT_VERSION) {
    throw new CredentialSlotError(
      "invalid-definition",
      "Unsupported credential slot version",
      definition.slotId,
    );
  }
  if (definition.placement !== "header" || typeof definition.required !== "boolean") {
    throw new CredentialSlotError(
      "invalid-definition",
      "Credential slot placement or required posture is invalid",
      definition.slotId,
    );
  }
  const slotId = normalizeId(definition.slotId);
  const resolverId = normalizeId(definition.resolverId);
  if (!slotId || !resolverId) {
    throw new CredentialSlotError(
      "invalid-definition",
      "Credential slot and resolver IDs are required",
      slotId || undefined,
    );
  }
  const allowedOrigins = normalizeOrigins(definition.allowedOrigins);
  if (allowedOrigins.length === 0) {
    throw new CredentialSlotError(
      "invalid-definition",
      "Credential slot requires at least one allowed origin",
      slotId,
    );
  }
  return {
    ...definition,
    slotId,
    resolverId,
    headerName: normalizeHeaderName(definition.headerName),
    allowedOrigins,
  };
}

function normalizeResolver(resolver: CredentialSlotResolverV1): CredentialSlotResolverV1 {
  if (resolver.version !== CREDENTIAL_SLOT_RESOLVER_VERSION) {
    throw new CredentialSlotError(
      "incompatible-resolver",
      "Unsupported credential resolver version",
      resolver.slotId,
    );
  }
  if (resolver.placement !== "header" || typeof resolver.resolve !== "function") {
    throw new CredentialSlotError(
      "incompatible-resolver",
      "Credential resolver placement or implementation is invalid",
      resolver.slotId,
    );
  }
  const resolverId = normalizeId(resolver.resolverId);
  const slotId = normalizeId(resolver.slotId);
  if (!resolverId || !slotId) {
    throw new CredentialSlotError(
      "invalid-definition",
      "Credential resolver and slot IDs are required",
      slotId || undefined,
    );
  }
  return {
    ...resolver,
    resolverId,
    slotId,
    headerName: normalizeHeaderName(resolver.headerName),
    allowedOrigins: normalizeOrigins(resolver.allowedOrigins),
  };
}

function assertCompatible(
  definition: CredentialSlotDefinitionV1,
  resolver: CredentialSlotResolverV1,
): void {
  if (
    resolver.slotId !== definition.slotId ||
    resolver.placement !== definition.placement ||
    resolver.headerName !== definition.headerName ||
    resolver.allowedOrigins.length !== definition.allowedOrigins.length ||
    resolver.allowedOrigins.some((origin, index) => origin !== definition.allowedOrigins[index])
  ) {
    throw new CredentialSlotError(
      "incompatible-resolver",
      `Credential resolver is incompatible with slot "${definition.slotId}"`,
      definition.slotId,
    );
  }
}

export function prepareCredentialSlotBindingsV1(params: {
  definitions: CredentialSlotDefinitionV1[];
  resolvers: CredentialSlotResolverV1[];
}): PreparedCredentialSlotBindingsV1 {
  const resolversById = new Map<string, CredentialSlotResolverV1>();
  for (const rawResolver of params.resolvers) {
    const resolver = normalizeResolver(rawResolver);
    if (resolversById.has(resolver.resolverId)) {
      throw new CredentialSlotError(
        "duplicate-resolver",
        `Duplicate credential resolver "${resolver.resolverId}"`,
        resolver.slotId,
      );
    }
    resolversById.set(resolver.resolverId, resolver);
  }

  const slots = new Map<string, PreparedCredentialSlot>();
  const headerOwners = new Map<string, string>();
  for (const rawDefinition of params.definitions) {
    const definition = normalizeDefinition(rawDefinition);
    if (slots.has(definition.slotId)) {
      throw new CredentialSlotError(
        "duplicate-slot",
        `Duplicate credential slot "${definition.slotId}"`,
        definition.slotId,
      );
    }
    const resolver = resolversById.get(definition.resolverId);
    if (!resolver) {
      throw new CredentialSlotError(
        "missing-resolver",
        `Credential resolver is missing for slot "${definition.slotId}"`,
        definition.slotId,
      );
    }
    assertCompatible(definition, resolver);
    for (const origin of definition.allowedOrigins) {
      const headerKey = `${origin}\n${definition.headerName}`;
      const existingSlotId = headerOwners.get(headerKey);
      if (existingSlotId) {
        throw new CredentialSlotError(
          "ambiguous-header",
          `Credential slots "${existingSlotId}" and "${definition.slotId}" target the same header and origin`,
          definition.slotId,
        );
      }
      headerOwners.set(headerKey, definition.slotId);
    }
    slots.set(definition.slotId, { definition, resolver });
  }

  const readiness = [...slots.values()]
    .map(({ definition, resolver }) => ({
      slotId: definition.slotId,
      resolverId: resolver.resolverId,
      version: definition.version,
      resolverVersion: resolver.version,
      placement: definition.placement,
      headerName: definition.headerName,
      allowedOrigins: [...definition.allowedOrigins],
      required: definition.required,
    }))
    .toSorted((left, right) => left.slotId.localeCompare(right.slotId));

  return {
    readiness: () =>
      readiness.map((entry) => ({
        slotId: entry.slotId,
        resolverId: entry.resolverId,
        version: entry.version,
        resolverVersion: entry.resolverVersion,
        placement: entry.placement,
        headerName: entry.headerName,
        allowedOrigins: [...entry.allowedOrigins],
        required: entry.required,
      })),
    apply: async ({ slotRefs, url, init, signal, now = Date.now }) => {
      const origin = new URL(url).origin;
      const headers = new Headers(init.headers);
      const seen = new Set<string>();
      const requested: PreparedCredentialSlot[] = [];

      for (const rawSlotId of slotRefs) {
        const slotId = normalizeId(rawSlotId);
        if (seen.has(slotId)) {
          throw new CredentialSlotError(
            "duplicate-reference",
            `Credential slot "${slotId}" was requested more than once`,
            slotId,
          );
        }
        seen.add(slotId);

        const prepared = slots.get(slotId);
        if (!prepared) {
          throw new CredentialSlotError(
            "unknown-slot",
            `Credential slot "${slotId}" is not prepared`,
            slotId,
          );
        }
        const { definition } = prepared;
        if (!definition.allowedOrigins.includes(origin)) {
          throw new CredentialSlotError(
            "origin-denied",
            `Credential slot "${slotId}" is not allowed for origin "${origin}"`,
            slotId,
          );
        }
        if (headers.has(definition.headerName)) {
          throw new CredentialSlotError(
            "header-conflict",
            `Credential slot "${slotId}" cannot replace an existing protected header`,
            slotId,
          );
        }
        requested.push(prepared);
      }

      for (const { definition, resolver } of requested) {
        const credential = await resolver.resolve({
          slotId: definition.slotId,
          origin,
          signal,
        });
        if (!credential) {
          if (definition.required) {
            throw new CredentialSlotError(
              "credential-unavailable",
              `Credential slot "${definition.slotId}" is unavailable`,
              definition.slotId,
            );
          }
          continue;
        }
        if (typeof credential.value !== "string" || credential.value.length === 0) {
          throw new CredentialSlotError(
            "credential-unavailable",
            `Credential slot "${definition.slotId}" returned an invalid value`,
            definition.slotId,
          );
        }
        if (
          credential.expiresAtMs !== undefined &&
          (!Number.isFinite(credential.expiresAtMs) || credential.expiresAtMs <= now())
        ) {
          throw new CredentialSlotError(
            "credential-expired",
            `Credential slot "${definition.slotId}" is expired`,
            definition.slotId,
          );
        }
        headers.set(definition.headerName, credential.value);
      }

      return { ...init, headers };
    },
  };
}
