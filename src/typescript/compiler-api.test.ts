import { describe, expect, it } from "vitest";
import {
  CLASSIC_TYPESCRIPT_COMPILER_API_REQUIREMENTS,
  formatTypeScriptCompilerApiLoadError,
} from "./compiler-api.js";

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
    expect(message).toContain("Original error");
  });
});
