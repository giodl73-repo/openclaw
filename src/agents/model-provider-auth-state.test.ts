import { describe, expect, it } from "vitest";
import { isProviderAuthWarmSnapshot } from "./model-provider-auth-state.js";

describe("provider auth warm snapshot", () => {
  it("rejects a null default model route", () => {
    expect(
      isProviderAuthWarmSnapshot({
        agents: [
          {
            agentId: "default",
            configFingerprint: "fingerprint",
            providers: [["openai", true]],
            defaultModelRoute: null,
          },
        ],
      }),
    ).toBe(false);
  });
});
