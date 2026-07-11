import { describe, expect, it } from "vitest";
import {
  CLASSIC_TYPESCRIPT_COMPILER_API_REQUIREMENTS,
  formatTypeScriptCompilerApiLoadError,
} from "./compiler-api.js";
import {
  getTypeScriptNativeApiCoverage,
  summarizeTypeScriptNativeApiCoverage,
} from "./native-api-coverage.js";

describe("TypeScript compiler API compatibility", () => {
  it("reports the classic API requirements for rootless TS native packages", () => {
    const message = formatTypeScriptCompilerApiLoadError(
      new Error('No "exports" main defined in typescript/package.json'),
      {
        exports: ["./package.json", "./unstable/sync", "./unstable/ast", "./unstable/ast/is"],
        version: "7.0.1-rc",
      },
    );

    expect(message).toContain('root "typescript" module');
    for (const api of CLASSIC_TYPESCRIPT_COMPILER_API_REQUIREMENTS) {
      expect(message).toContain(api);
    }
    expect(message).toContain("typescript@7.0.1-rc");
    expect(message).toContain("typescript/unstable/*");
    expect(message).toContain("./unstable/sync");
    expect(message).toContain("transpileModule: missing");
    expect(message).toContain("SyntaxKind: available via typescript/unstable/ast");
    expect(message).toContain("Original error");
  });

  it("maps classic compiler API requirements to TS7 unstable API coverage", () => {
    expect(getTypeScriptNativeApiCoverage("SyntaxKind")).toMatchObject({
      nativeEntrypoints: ["typescript/unstable/ast"],
      status: "available",
    });
    expect(getTypeScriptNativeApiCoverage("transpileModule")).toMatchObject({
      nativeEntrypoints: [],
      status: "missing",
    });
    expect(summarizeTypeScriptNativeApiCoverage()).toContain(
      "createProgram: partial via typescript/unstable/sync",
    );
  });
});
