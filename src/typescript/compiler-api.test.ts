import { describe, expect, it } from "vitest";
import { formatTypeScriptCompilerApiLoadError } from "./compiler-api.js";

describe("TypeScript compiler API compatibility", () => {
  it("reports the classic API requirements for rootless TS native packages", () => {
    const message = formatTypeScriptCompilerApiLoadError(
      new Error('No "exports" main defined in typescript/package.json'),
    );

    expect(message).toContain('root "typescript" module');
    expect(message).toContain("transpileModule");
    expect(message).toContain("createProgram");
    expect(message).toContain("typescript/unstable/*");
    expect(message).toContain("Original error");
  });
});
