export type ClassicTypeScriptCompilerApiRequirement =
  (typeof CLASSIC_TYPESCRIPT_COMPILER_API_REQUIREMENTS)[number];

export const CLASSIC_TYPESCRIPT_COMPILER_API_REQUIREMENTS = [
  "transpileModule",
  "createProgram",
  "createPrinter",
  "parseJsonConfigFileContent",
  "readConfigFile",
  "sys",
  "SyntaxKind",
] as const;

export type TypeScriptNativeApiCoverageStatus = "available" | "partial" | "missing";

export type TypeScriptNativeApiCoverage = {
  classicApi: ClassicTypeScriptCompilerApiRequirement;
  nativeEntrypoints: string[];
  notes: string;
  status: TypeScriptNativeApiCoverageStatus;
};

export const TS7_UNSTABLE_TYPESCRIPT_API_COVERAGE: readonly TypeScriptNativeApiCoverage[] = [
  {
    classicApi: "transpileModule",
    nativeEntrypoints: [],
    notes:
      "No direct single-file transpile helper is exposed by the TS7 unstable exports; Code Mode still needs a runtime-safe TypeScript transform.",
    status: "missing",
  },
  {
    classicApi: "createProgram",
    nativeEntrypoints: ["typescript/unstable/sync"],
    notes:
      "The sync API exposes Program, Project, Snapshot, and Checker primitives, but OpenClaw still needs an adapter from classic createProgram usage.",
    status: "partial",
  },
  {
    classicApi: "createPrinter",
    nativeEntrypoints: ["typescript/unstable/sync"],
    notes:
      "The sync API exposes Emitter.printNode-like behavior, but the plugin SDK baseline printer path still needs parity validation.",
    status: "partial",
  },
  {
    classicApi: "parseJsonConfigFileContent",
    nativeEntrypoints: ["typescript/unstable/fs"],
    notes: "No direct tsconfig parse helper parity has been confirmed in the unstable API surface.",
    status: "missing",
  },
  {
    classicApi: "readConfigFile",
    nativeEntrypoints: ["typescript/unstable/fs"],
    notes:
      "File helpers may cover raw reads, but classic readConfigFile error-shaping/parsing parity is not exposed as a direct helper.",
    status: "partial",
  },
  {
    classicApi: "sys",
    nativeEntrypoints: ["typescript/unstable/fs"],
    notes:
      "The unstable fs entrypoint can replace host file operations only after OpenClaw stops depending on the classic sys object shape.",
    status: "partial",
  },
  {
    classicApi: "SyntaxKind",
    nativeEntrypoints: ["typescript/unstable/ast"],
    notes: "The unstable AST entrypoint exposes SyntaxKind and node helpers.",
    status: "available",
  },
] as const;

export function getTypeScriptNativeApiCoverage(
  classicApi: ClassicTypeScriptCompilerApiRequirement,
): TypeScriptNativeApiCoverage {
  const coverage = TS7_UNSTABLE_TYPESCRIPT_API_COVERAGE.find(
    (entry) => entry.classicApi === classicApi,
  );
  if (!coverage) {
    throw new Error(`No TS7/native coverage entry for classic TypeScript API "${classicApi}"`);
  }
  return coverage;
}

export function summarizeTypeScriptNativeApiCoverage(): string {
  return TS7_UNSTABLE_TYPESCRIPT_API_COVERAGE.map(
    (entry) =>
      `${entry.classicApi}: ${entry.status}${
        entry.nativeEntrypoints.length > 0 ? ` via ${entry.nativeEntrypoints.join(", ")}` : ""
      }`,
  ).join("; ");
}
