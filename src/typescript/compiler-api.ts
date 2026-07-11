import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type TypeScriptCompilerApi = {
  createPrinter: (...args: unknown[]) => any;
  createProgram: (...args: unknown[]) => any;
  DiagnosticCategory: Record<string, number>;
  EmitHint: Record<string, number>;
  findConfigFile: (...args: unknown[]) => string | undefined;
  flattenDiagnosticMessageText: (messageText: unknown, newLine: string) => string;
  getCombinedNodeFlags: (node: unknown) => number;
  ImportsNotUsedAsValues: Record<string, unknown>;
  isClassDeclaration: (node: unknown) => boolean;
  isEnumDeclaration: (node: unknown) => boolean;
  isFunctionDeclaration: (node: unknown) => boolean;
  isInterfaceDeclaration: (node: unknown) => boolean;
  isModuleDeclaration: (node: unknown) => boolean;
  isTypeAliasDeclaration: (node: unknown) => boolean;
  isVariableDeclaration: (node: unknown) => boolean;
  isVariableStatement: (node: unknown) => boolean;
  ModuleKind: Record<string, unknown>;
  NewLineKind: Record<string, unknown>;
  NodeFlags: Record<string, number>;
  parseJsonConfigFileContent: (...args: unknown[]) => any;
  readConfigFile: (...args: unknown[]) => { config?: unknown; error?: { messageText: unknown } };
  ScriptTarget: Record<string, unknown>;
  SymbolFlags: Record<string, number>;
  SyntaxKind: Record<string, number>;
  sys: {
    fileExists: (path: string) => boolean;
    readFile: (path: string) => string | undefined;
  };
  transpileModule: (
    code: string,
    options: {
      compilerOptions: Record<string, unknown>;
      reportDiagnostics?: boolean;
    },
  ) => {
    diagnostics?: Array<{ category: number; messageText: unknown }>;
    outputText: string;
  };
  TypeFormatFlags: Record<string, number>;
};

export type TsChecker = any;
export type TsDeclaration = any;
export type TsPrinter = any;
export type TsProgram = any;
export type TsSymbol = any;

let cachedClassicApi: TypeScriptCompilerApi | null = null;

export function loadClassicTypeScriptCompilerApi(): TypeScriptCompilerApi {
  if (cachedClassicApi) {
    return cachedClassicApi;
  }
  try {
    cachedClassicApi = require("typescript") as TypeScriptCompilerApi;
    return cachedClassicApi;
  } catch (error) {
    throw new Error(
      `OpenClaw currently requires the classic TypeScript compiler API from the root "typescript" module. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function loadClassicTypeScriptCompilerApiAsync(): Promise<TypeScriptCompilerApi> {
  return loadClassicTypeScriptCompilerApi();
}
