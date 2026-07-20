export const CONTINUITY_PUBLICATION_PROVIDER_VERSION =
  "continuity-publication-provider/v1" as const;
export const CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION =
  "continuity-publication-acceptance/v1" as const;
export const CONTINUITY_PUBLICATION_RETRIEVAL_VERSION =
  "continuity-publication-retrieval/v1" as const;

export type ContinuityPublicationIdentityV1 = {
  ownerId: string;
  sourceRuntimeGeneration: string;
  handoffId: string;
  captureId: string;
  archiveSha256: string;
  manifestSha256: string;
  archiveSize: number;
};

export type ContinuityPublicationProviderReferenceV1 = {
  pluginId: string;
  id: string;
  version: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
  generation: string;
};

export type ContinuityPublicationProviderAcceptanceV1 = {
  version: typeof CONTINUITY_PUBLICATION_ACCEPTANCE_VERSION;
  publicationId: string;
  identity: ContinuityPublicationIdentityV1;
  durabilityClass: "immutable";
  acceptedAt: string;
};

export type ContinuityPublicationAcceptanceReceiptV1 = ContinuityPublicationProviderAcceptanceV1 & {
  publicationPluginId: string;
  publicationBindingId: string;
  publicationBindingVersion: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
  publicationBindingGeneration: string;
};

export type ContinuityPublicationRetrievalV1 = {
  version: typeof CONTINUITY_PUBLICATION_RETRIEVAL_VERSION;
  publicationId: string;
  identity: ContinuityPublicationIdentityV1;
  content: AsyncIterable<Uint8Array>;
};

export type ContinuityPublicationProviderV1 = {
  id: string;
  version: typeof CONTINUITY_PUBLICATION_PROVIDER_VERSION;
  generation: string;
  publish: (params: {
    identity: ContinuityPublicationIdentityV1;
    content: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }) => Promise<ContinuityPublicationProviderAcceptanceV1>;
  retrieve: (params: {
    receipt: ContinuityPublicationAcceptanceReceiptV1;
    signal: AbortSignal;
  }) => Promise<ContinuityPublicationRetrievalV1>;
};

export type ContinuityPublicationProviderFailureCode =
  | "retryable-before-commit"
  | "outcome-unknown"
  | "conflict"
  | "corrupt-retrieval"
  | "unavailable"
  | "cancelled";

export type ContinuityPublicationProviderFailureV1 = {
  code: ContinuityPublicationProviderFailureCode;
  message: string;
};
