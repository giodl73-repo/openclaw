type HostIntegrationAuthorityChangeListener = () => void;

const listeners = new Set<HostIntegrationAuthorityChangeListener>();

export function notifyHostIntegrationAuthorityChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeHostIntegrationAuthorityChanges(
  listener: HostIntegrationAuthorityChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
