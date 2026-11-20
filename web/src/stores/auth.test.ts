import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { __resetUiStoreForTests, readUiValue } from "@/lib/ui-store";
import { huanxingAuthAtom } from "./auth";

describe("account persistence", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("persists and clears the account", () => {
    const store = createStore();
    const account = {
      serverUrl: "https://account.example.test",
      userId: 42,
      username: "alice",
      accessToken: "test-access-token",
    };

    store.set(huanxingAuthAtom, account);
    expect(store.get(huanxingAuthAtom)).toEqual(account);
    expect(readUiValue("hermes.huanxing-auth", null)).toEqual(account);

    store.set(huanxingAuthAtom, null);
    expect(store.get(huanxingAuthAtom)).toBeNull();
    expect(readUiValue("hermes.huanxing-auth", null)).toBeNull();
  });
});
