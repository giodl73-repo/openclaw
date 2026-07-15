import path from "node:path";

const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,255}$/u;

export type LobsterHostConfig = {
  publicationRoot: string;
  providerGeneration: string;
};

export function resolveLobsterHostConfig(
  value: unknown,
  resolvePath: (value: string) => string,
): LobsterHostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lobster-host plugin config must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["providerGeneration", "publicationRoot"];
  if (
    Object.keys(record).length !== expected.length ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw new Error("lobster-host plugin config contains unknown or missing fields");
  }
  if (typeof record.publicationRoot !== "string" || record.publicationRoot.length === 0) {
    throw new Error("lobster-host publicationRoot is required");
  }
  if (
    !path.isAbsolute(record.publicationRoot) ||
    path.normalize(record.publicationRoot) !== record.publicationRoot
  ) {
    throw new Error("lobster-host publicationRoot must be a normalized absolute path");
  }
  const publicationRoot = resolvePath(record.publicationRoot);
  if (!path.isAbsolute(publicationRoot) || path.normalize(publicationRoot) !== publicationRoot) {
    throw new Error("lobster-host publicationRoot must resolve to a normalized absolute path");
  }
  if (
    typeof record.providerGeneration !== "string" ||
    !GENERATION_PATTERN.test(record.providerGeneration)
  ) {
    throw new Error("lobster-host providerGeneration is invalid");
  }
  return {
    publicationRoot,
    providerGeneration: record.providerGeneration,
  };
}
