import { describe, expect, it } from "vitest";
import { isReadRequest } from "../state/openclaw-state-read.validation.js";

describe("Claw inventory worker admission", () => {
  const request = {
    databasePath: "/fixture/state.sqlite",
    location: "existing",
    checkFreshAdmission: true,
    context: { environment: { OPENCLAW_STATE_DIR: "/fixture" } },
    command: { type: "claws.inventory" },
  };

  it("admits the inventory command with captured worker context", () => {
    expect(isReadRequest(request)).toBe(true);
  });

  it("does not admit mutation commands or uncaptured locations", () => {
    expect(isReadRequest({ ...request, command: { type: "claws.apply" } })).toBe(false);
    expect(isReadRequest({ ...request, context: { environment: {} } })).toBe(false);
  });
});
