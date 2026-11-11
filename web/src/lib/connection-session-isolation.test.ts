import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai/vanilla";
import { __resetUiStoreForTests, readUiValue, writeUiValue } from "./ui-store";
import { sessionStorageKey } from "./connection-scope";
import { invalidateAttachedSessions, isGatewaySessionAttached, rememberSessionMapping, resolvePersistentSessionId } from "./session-map";
import { activeSessionIdAtom, hydratePersistedUiAtoms } from "@/stores/ui";
import { gwSessionIdAtom, hydratePersistedChatAtoms } from "@/stores/chat";

function target(connectionMode: "managed" | "local" | "remote", apiBaseUrl = "http://127.0.0.1:9120") {
  vi.stubGlobal("window", { __HERMES_RUNTIME__: { connectionMode, apiBaseUrl } });
}

afterEach(() => { vi.unstubAllGlobals(); invalidateAttachedSessions(); });

describe("connection session isolation", () => {
  it("keeps managed session state while remote targets cannot resume its IDs", () => {
    target("managed");
    __resetUiStoreForTests();
    const store = createStore();
    store.set(activeSessionIdAtom, "managed-history");
    store.set(gwSessionIdAtom, "gw-same");
    rememberSessionMapping("gw-same", "managed-history");
    writeUiValue("hermes-theme", { mode: "dark" });

    target("remote", "https://gateway-a.test/hermes/");
    hydratePersistedUiAtoms(store);
    hydratePersistedChatAtoms(store);
    expect(store.get(activeSessionIdAtom)).toBeNull();
    expect(store.get(gwSessionIdAtom)).toBeNull();
    expect(resolvePersistentSessionId("gw-same")).toBe("gw-same");
    expect(isGatewaySessionAttached("gw-same")).toBe(false);
    expect(readUiValue("hermes-theme", {})).toEqual({ mode: "dark" });
    store.set(activeSessionIdAtom, "remote-history");
    store.set(gwSessionIdAtom, "gw-same");
    rememberSessionMapping("gw-same", "remote-history");

    target("remote", "https://gateway-b.test/hermes");
    hydratePersistedUiAtoms(store);
    hydratePersistedChatAtoms(store);
    expect(store.get(activeSessionIdAtom)).toBeNull();
    expect(store.get(gwSessionIdAtom)).toBeNull();
    expect(isGatewaySessionAttached("gw-same")).toBe(false);

    target("remote", "https://gateway-a.test/hermes");
    hydratePersistedUiAtoms(store);
    hydratePersistedChatAtoms(store);
    expect(store.get(activeSessionIdAtom)).toBe("remote-history");
    expect(store.get(gwSessionIdAtom)).toBe("gw-same");
    expect(resolvePersistentSessionId("gw-same")).toBe("remote-history");

    target("managed");
    hydratePersistedUiAtoms(store);
    hydratePersistedChatAtoms(store);
    expect(store.get(activeSessionIdAtom)).toBe("managed-history");
    expect(resolvePersistentSessionId("gw-same")).toBe("managed-history");
  });

  it("isolates local attachments and proxy paths without persisting credentials", () => {
    target("remote", "https://user:secret@gateway.test/a/?token=secret#fragment");
    const key = sessionStorageKey("session");
    expect(key).not.toContain("secret");
    target("remote", "https://gateway.test/a");
    expect(sessionStorageKey("session")).toBe(key);
    target("remote", "https://gateway.test/b");
    expect(sessionStorageKey("session")).not.toBe(key);
    target("local", "https://gateway.test/a");
    expect(sessionStorageKey("session")).not.toBe(key);
  });
});
