import { CredentialSlotError, type PreparedCredentialSlotBindingsV1 } from "./credential-slot.js";
import type { DispatcherAwareRequestInit } from "./runtime-fetch.js";

export type OneHopFetchRequest = {
  url: string;
  init: DispatcherAwareRequestInit & { redirect: "manual" };
  credentialSlotRefs?: string[];
};

export type OneHopFetchDispatcher = {
  dispatch: (request: OneHopFetchRequest) => Promise<Response>;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LocalOneHopFetch = (url: string, init: OneHopFetchRequest["init"]) => Promise<Response>;

export type LocalOneHopFetchDispatcherOptions = {
  credentialSlots?: PreparedCredentialSlotBindingsV1;
};

export function createLocalOneHopFetchDispatcher(
  fetchImpl: LocalOneHopFetch,
  options: LocalOneHopFetchDispatcherOptions = {},
): OneHopFetchDispatcher {
  return {
    dispatch: async ({ url, init, credentialSlotRefs = [] }) => {
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
