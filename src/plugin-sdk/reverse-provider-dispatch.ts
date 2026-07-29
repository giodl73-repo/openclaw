/**
 * Public contracts for a plugin-owned reverse provider-dispatch connection.
 *
 * The plugin remains responsible for authenticating its peer and owning the
 * accepted transport. These helpers validate only the bounded carrier,
 * admitted-session, and operation-ownership contracts.
 */
export {
  REVERSE_PROVIDER_DISPATCH_MAX_FRAME_BYTES_V1,
  REVERSE_PROVIDER_DISPATCH_VERSION,
  assertReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchCertainty,
  type ReverseProviderDispatchFailureCode,
  type ReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchOperationOpenV1,
} from "../infra/net/reverse-provider-dispatch.js";
export {
  PROVIDER_REQUEST_DISPATCHER_INTERFACE_VERSION,
  REVERSE_PROVIDER_SESSION_VERSION,
  ReverseProviderSessionRegistryV1,
  type ReverseProviderSessionAdmissionResultV1,
  type ReverseProviderSessionAuthorityV1,
  type ReverseProviderSessionDeclarationV1,
  type ReverseProviderSessionV1,
  type ReverseProviderVerifiedPeerV1,
} from "../infra/net/reverse-provider-session.js";
export {
  REVERSE_PROVIDER_MAX_ACTIVE_OPERATIONS_V1,
  ReverseProviderOperationRegistryV1,
  type ReverseProviderOperationClaimResultV1,
  type ReverseProviderOperationFrameResultV1,
  type ReverseProviderOperationOwnershipV1,
} from "../infra/net/reverse-provider-operation-registry.js";
export {
  prepareReverseProviderOwnerBindingV1,
  REVERSE_PROVIDER_OWNER_GENERATION_VERSION,
  type PreparedReverseProviderOwnerBindingV1,
  type ReverseProviderOwnerPreparationInputV1,
} from "../infra/net/reverse-provider-owner-preparation.js";
