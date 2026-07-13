import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPI_BEARER_SLOT_ID,
  CAPI_MODEL_ADAPTER_ID,
  CAPI_MODEL_ADAPTER_VERSION,
} from "../agents/model-provider-adapters/capi.js";
import { CREDENTIAL_SLOT_RESOLVER_VERSION } from "../infra/net/credential-slot.js";
import { subscribeHostIntegrationAuthorityChanges } from "./host-integration-authority-events.js";
import {
  HOST_INTEGRATION_BUNDLE_VERSION,
  HostIntegrationBundleError,
  clearCurrentHostIntegrationBundleSnapshotV1,
  getCurrentHostIntegrationBundleSnapshotV1,
  prepareHostIntegrationBundleSnapshotV1,
  registerHostIntegrationBundleV1,
  resolveHostIntegrationContributionV1,
  type AvailableHostIntegrationContributionV1,
  type HostIntegrationBundleManifestV1,
} from "./host-integration-bundle.js";

type Fixture = {
  manifest: HostIntegrationBundleManifestV1;
  availableContributions: AvailableHostIntegrationContributionV1[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/host-integration-bundle-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function cloneManifest(): HostIntegrationBundleManifestV1 {
  return structuredClone(fixture.manifest);
}

function cloneAvailable(): AvailableHostIntegrationContributionV1[] {
  return structuredClone(fixture.availableContributions);
}

afterEach(() => {
  clearCurrentHostIntegrationBundleSnapshotV1();
});

describe("host integration bundle registration", () => {
  it("notifies authority listeners after publication and clear", () => {
    const observed: Array<string | undefined> = [];
    const unsubscribe = subscribeHostIntegrationAuthorityChanges(() => {
      observed.push(getCurrentHostIntegrationBundleSnapshotV1()?.bundleVersion);
    });

    try {
      registerHostIntegrationBundleV1({
        manifest: cloneManifest(),
        availableContributions: cloneAvailable(),
      });
      clearCurrentHostIntegrationBundleSnapshotV1();
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual(["1.0.0", undefined]);
  });

  it("publishes one immutable effective inventory with owner provenance", () => {
    const snapshot = registerHostIntegrationBundleV1({
      manifest: cloneManifest(),
      availableContributions: cloneAvailable(),
    });

    expect(snapshot).toEqual({
      version: HOST_INTEGRATION_BUNDLE_VERSION,
      id: "lobster/host",
      bundleVersion: "1.0.0",
      inventory: [
        {
          owner: "continuity",
          kind: "lifecycle-restore-hold",
          id: "lobster/continuity",
          version: "continuity-restore-hold/v1",
          required: true,
          readinessCriteria: ["continuity.restore-hold"],
          status: "resolved",
          resolvedVersion: "continuity-restore-hold/v1",
          provenance: {
            pluginId: "lobster-host",
            source: "/plugins/lobster-host/openclaw.plugin.json",
            origin: "config",
          },
        },
        {
          owner: "model-provider",
          kind: "model-provider-adapter",
          id: CAPI_MODEL_ADAPTER_ID,
          version: CAPI_MODEL_ADAPTER_VERSION,
          required: true,
          readinessCriteria: ["model.provider.capi"],
          status: "resolved",
          resolvedVersion: CAPI_MODEL_ADAPTER_VERSION,
          provenance: {
            pluginId: "lobster-host",
            source: "/plugins/lobster-host/openclaw.plugin.json",
            origin: "config",
          },
        },
        {
          owner: "provider-request",
          kind: "credential-slot-resolver",
          id: CAPI_BEARER_SLOT_ID,
          version: CREDENTIAL_SLOT_RESOLVER_VERSION,
          required: true,
          readinessCriteria: ["provider.request.credentials.capi"],
          status: "resolved",
          resolvedVersion: CREDENTIAL_SLOT_RESOLVER_VERSION,
          provenance: {
            pluginId: "lobster-host",
            source: "/plugins/lobster-host/openclaw.plugin.json",
            origin: "config",
          },
        },
        {
          owner: "provider-request",
          kind: "provider-request-dispatcher",
          id: "lobster/egress",
          version: "provider-request-dispatcher/v1",
          required: true,
          readinessCriteria: ["provider.request.dispatch.lobster"],
          status: "resolved",
          resolvedVersion: "provider-request-dispatcher/v1",
          provenance: {
            pluginId: "lobster-host",
            source: "/plugins/lobster-host/openclaw.plugin.json",
            origin: "config",
          },
        },
      ],
    });
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.inventory)).toBe(true);
    expect(Object.isFrozen(snapshot.inventory[0]?.readinessCriteria)).toBe(true);
    expect(Object.isFrozen(snapshot.inventory[0]?.provenance)).toBe(true);
  });

  it("leaves the previous snapshot published when the next registration is invalid", () => {
    const first = registerHostIntegrationBundleV1({
      manifest: cloneManifest(),
      availableContributions: cloneAvailable(),
    });
    const missingResolver = cloneAvailable().filter(
      (contribution) => contribution.id !== CAPI_BEARER_SLOT_ID,
    );

    expect(() =>
      registerHostIntegrationBundleV1({
        manifest: cloneManifest(),
        availableContributions: missingResolver,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "missing-required-contribution",
        contributionId: CAPI_BEARER_SLOT_ID,
      }),
    );
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBe(first);
  });

  it("rejects duplicate declarations and ambiguous available contributions", () => {
    const duplicateManifest = cloneManifest();
    duplicateManifest.contributions.push(structuredClone(duplicateManifest.contributions[0]!));
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: duplicateManifest,
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-contribution" }));

    const crossOwnerDuplicate = cloneManifest();
    crossOwnerDuplicate.contributions.push({
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: CAPI_MODEL_ADAPTER_ID,
      version: CREDENTIAL_SLOT_RESOLVER_VERSION,
      required: false,
      readinessCriteria: [],
    });
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: crossOwnerDuplicate,
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-contribution" }));

    const duplicateAvailable = cloneAvailable();
    duplicateAvailable.push(structuredClone(duplicateAvailable[0]!));
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: cloneManifest(),
        availableContributions: duplicateAvailable,
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-available-contribution" }));

    const crossOwnerAvailable = cloneAvailable();
    crossOwnerAvailable.push({
      owner: "provider-request",
      kind: "credential-slot-resolver",
      id: CAPI_MODEL_ADAPTER_ID,
      version: CREDENTIAL_SLOT_RESOLVER_VERSION,
      provenance: structuredClone(crossOwnerAvailable[0]!.provenance),
    });
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: cloneManifest(),
        availableContributions: crossOwnerAvailable,
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-available-contribution" }));
  });

  it("rejects an incompatible required contribution before publication", () => {
    const incompatible = cloneAvailable();
    incompatible[0] = { ...incompatible[0]!, version: "capi-model-provider-adapter/v2" };

    expect(() =>
      registerHostIntegrationBundleV1({
        manifest: cloneManifest(),
        availableContributions: incompatible,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "incompatible-required-contribution",
        contributionId: CAPI_MODEL_ADAPTER_ID,
      }),
    );
    expect(getCurrentHostIntegrationBundleSnapshotV1()).toBeUndefined();
  });

  it("keeps optional failures visible without blocking the complete snapshot", () => {
    const manifest = cloneManifest();
    manifest.contributions[1] = { ...manifest.contributions[1]!, required: false };
    const snapshot = prepareHostIntegrationBundleSnapshotV1({
      manifest,
      availableContributions: cloneAvailable().filter(
        (contribution) => contribution.id !== CAPI_BEARER_SLOT_ID,
      ),
    });

    expect(snapshot.inventory.find((entry) => entry.id === CAPI_BEARER_SLOT_ID)).toEqual(
      expect.objectContaining({
        id: CAPI_BEARER_SLOT_ID,
        required: false,
        status: "missing",
      }),
    );
  });

  it("resolves only the typed id and exact version selected by an owner", () => {
    registerHostIntegrationBundleV1({
      manifest: cloneManifest(),
      availableContributions: cloneAvailable(),
    });

    expect(
      resolveHostIntegrationContributionV1({
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: CAPI_MODEL_ADAPTER_ID,
        version: CAPI_MODEL_ADAPTER_VERSION,
      }),
    ).toEqual(expect.objectContaining({ status: "resolved" }));
    expect(() =>
      resolveHostIntegrationContributionV1({
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: CAPI_MODEL_ADAPTER_ID,
        version: "capi-model-provider-adapter/v2",
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible-contribution" }));
    expect(() =>
      resolveHostIntegrationContributionV1({
        owner: "model-provider",
        kind: "model-provider-adapter",
        id: "lobster/missing",
        version: CAPI_MODEL_ADAPTER_VERSION,
      }),
    ).toThrowError(expect.objectContaining({ code: "unknown-contribution" }));
  });

  it("fails closed on malformed bundle identity and unsupported runtime kinds", () => {
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: null as never,
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-manifest" }));

    for (const bundleVersion of ["01.0.0", "v1.0.0", "1.0.0-alpha..1"]) {
      expect(() =>
        prepareHostIntegrationBundleSnapshotV1({
          manifest: { ...cloneManifest(), bundleVersion },
          availableContributions: cloneAvailable(),
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid-manifest" }));
    }

    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: { ...cloneManifest(), id: "lobster-host" },
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-manifest" }));

    const malformed = cloneManifest();
    malformed.contributions[0] = {
      ...malformed.contributions[0]!,
      owner: "gateway",
    } as never;
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: malformed,
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(HostIntegrationBundleError);

    const missingProvenance = cloneAvailable();
    missingProvenance[0] = {
      ...missingProvenance[0]!,
      provenance: undefined,
    } as never;
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: cloneManifest(),
        availableContributions: missingProvenance,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-manifest" }));

    const invalidRequired = cloneManifest();
    invalidRequired.contributions[0] = {
      ...invalidRequired.contributions[0]!,
      required: "yes",
    } as never;
    expect(() =>
      prepareHostIntegrationBundleSnapshotV1({
        manifest: invalidRequired,
        availableContributions: cloneAvailable(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-manifest" }));
  });
});
