export const CONNECTION_AUTH_RESTORED_EVENT = "hermes:connection-auth-restored";

export function notifyConnectionAuthRestored(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CONNECTION_AUTH_RESTORED_EVENT));
}

export function onConnectionAuthRestored(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CONNECTION_AUTH_RESTORED_EVENT, listener);
  return () => window.removeEventListener(CONNECTION_AUTH_RESTORED_EVENT, listener);
}
