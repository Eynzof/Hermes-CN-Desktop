import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { __resetUiStoreForTests, readUiValue } from "@/lib/ui-store";
import {
  dismissTeamDeviceTokenOnboarding,
  huanxingAuthAtom,
  isTeamDeviceTokenOnboardingDismissed,
  resetTeamDeviceTokenOnboarding,
} from "./auth";

describe("team device token onboarding preference", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("persists a skip and can reset it after a successful binding", () => {
    expect(isTeamDeviceTokenOnboardingDismissed()).toBe(false);

    dismissTeamDeviceTokenOnboarding();
    expect(isTeamDeviceTokenOnboardingDismissed()).toBe(true);

    resetTeamDeviceTokenOnboarding();
    expect(isTeamDeviceTokenOnboardingDismissed()).toBe(false);
  });

  it("persists and clears the enterprise account independently of device onboarding", () => {
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
    expect(isTeamDeviceTokenOnboardingDismissed()).toBe(false);

    store.set(huanxingAuthAtom, null);
    expect(store.get(huanxingAuthAtom)).toBeNull();
    expect(readUiValue("hermes.huanxing-auth", null)).toBeNull();
  });
});
