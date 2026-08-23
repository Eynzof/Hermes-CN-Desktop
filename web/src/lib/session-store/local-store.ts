import { SessionStore } from "./session-store";
import { createLocalPersistentSqlAdapter } from "./local";

let store: SessionStore | null = null;

/**
 * Shared singleton for the local-first session store used by the standalone
 * (no-backend) mode: the in-process gateway writes conversation turns here
 * and the dashboard REST handlers (`/api/sessions*`) read from the same
 * instance, so the chat page, history page and detail page all agree.
 */
export function getLocalSessionStore(): SessionStore {
  if (!store) {
    store = new SessionStore({ adapter: createLocalPersistentSqlAdapter("local-sessions-v1") });
  }
  return store;
}

/** Test hook: drop the singleton so tests get a fresh store. */
export function resetLocalSessionStore(): void {
  store = null;
}