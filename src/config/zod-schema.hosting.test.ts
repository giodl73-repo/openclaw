import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("hosting config schema", () => {
  it("accepts built-in hosting profiles", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "container",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hosting?.profile).toBe("container");
    }
  });

  it("rejects unknown hosting profiles", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "custom-host",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.profile");
    }
  });

  it("accepts declared custom hosting profiles and conditions", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "acme.managed",
        criteria: {
          "acme.backup-ready": {
            status: "True",
            reason: "BackupReady",
            message: "Backup volume restored.",
          },
          "acme.telemetry-ready": {
            status: "False",
            reason: "TelemetryUnavailable",
          },
        },
        profiles: {
          "acme.managed": {
            extends: "container",
            label: "Acme managed",
            readiness: {
              requiredCriteria: ["acme.backup-ready"],
            },
          },
        },
        readiness: {
          optionalCriteria: ["acme.telemetry-ready"],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hosting?.profile).toBe("acme.managed");
      expect(result.config.hosting?.profiles?.["acme.managed"]?.extends).toBe("container");
    }
  });

  it("rejects undeclared custom profile selection", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "acme.missing",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.profile");
    }
  });

  it("rejects custom profile definitions that shadow built-ins", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profiles: {
          local: {
            extends: "container",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.profiles.local");
    }
  });

  it("rejects custom condition types that are not namespaced", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        readiness: {
          requiredCriteria: ["GatewayResponding"],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.readiness.requiredCriteria.0");
    }
  });

  it("rejects references to undeclared criteria", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        readiness: {
          requiredCriteria: ["acme.missing-ready"],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.readiness");
    }
  });
});
