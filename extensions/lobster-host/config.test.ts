import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveLobsterHostConfig } from "./config.js";

describe("resolveLobsterHostConfig", () => {
  it("requires a durable publication root and stable generation", () => {
    const root = path.resolve("durable-continuity");

    expect(
      resolveLobsterHostConfig(
        { publicationRoot: root, providerGeneration: "provider-7" },
        path.resolve,
      ),
    ).toStrictEqual({
      publicationRoot: root,
      providerGeneration: "provider-7",
    });
  });

  it("rejects incomplete or extensible config", () => {
    expect(() =>
      resolveLobsterHostConfig({ publicationRoot: path.resolve("continuity") }, path.resolve),
    ).toThrow(/unknown or missing/u);
    expect(() =>
      resolveLobsterHostConfig(
        {
          publicationRoot: path.resolve("continuity"),
          providerGeneration: "provider-7",
          destination: "https://example.invalid",
        },
        path.resolve,
      ),
    ).toThrow(/unknown or missing/u);
  });

  it("rejects a relative publication root before resolving it", () => {
    const resolvePath = vi.fn(path.resolve);

    expect(() =>
      resolveLobsterHostConfig(
        { publicationRoot: "continuity", providerGeneration: "provider-7" },
        resolvePath,
      ),
    ).toThrow(/normalized absolute path/u);
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
