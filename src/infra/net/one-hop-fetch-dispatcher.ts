import { CredentialSlotError, type PreparedCredentialSlotBindingsV1 } from "./credential-slot.js";
import {
  assertLocalNetworkGuardPrepared,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";

export type OneHopFetchRequest = {
  url: string;
  init: RequestInit & { redirect: "manual" };
  networkGuard: NetworkGuardProfileV1;
  credentialSlotRefs?: string[];
};

export type OneHopFetchDispatcher = {
  dispatch: (request: OneHopFetchRequest) => Promise<Response>;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LocalOneHopFetch = (url: string, init: OneHopFetchRequest["init"]) => Promise<Response>;

export type LocalOneHopFetchDispatcherOptions = {
  hasPreparedDispatcher?: boolean;
  credentialSlots?: PreparedCredentialSlotBindingsV1;
};

export function createLocalOneHopFetchDispatcher(
  fetchImpl: LocalOneHopFetch,
  options: LocalOneHopFetchDispatcherOptions = {},
): OneHopFetchDispatcher {
  return {
    dispatch: async ({ url, init, networkGuard, credentialSlotRefs = [] }) => {
      assertLocalNetworkGuardPrepared({
        profile: networkGuard,
        requestUrl: url,
        hasDispatcher: options.hasPreparedDispatcher === true,
      });
      const credentialSlots = options.credentialSlots;
      if (credentialSlotRefs.length > 0 && !credentialSlots) {
        throw new CredentialSlotError(
          "missing-resolver",
          "Credential slots were requested without a prepared resolver binding",
          credentialSlotRefs[0],
        );
      }
      const resolvedInit =
        credentialSlots && credentialSlotRefs.length > 0
          ? ((await credentialSlots.apply({
              slotRefs: credentialSlotRefs,
              url,
              init,
              signal: init.signal ?? undefined,
            })) as OneHopFetchRequest["init"])
          : init;
      return await fetchImpl(url, resolvedInit);
    },
  };
}
