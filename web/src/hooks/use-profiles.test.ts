import { describe, expect, it } from "vitest";
import { resolveBootstrapProfile } from "./use-profiles";

describe("resolveBootstrapProfile", () => {
  // 核心回归测试（#189/#195）：首次同步完成后，过期的 /api/profiles/active 值
  // 不能再把刚切回 default 的 atom 改回旧档案。
  it("never reverts a deliberate switch once hydrated, even with stale query data", () => {
    expect(
      resolveBootstrapProfile({
        alreadyHydrated: true,
        current: "default",
        electronProfile: "default",
        queryData: "other", // 切换瞬间后端 query 仍是旧值
      }),
    ).toEqual({ next: null, hydrated: true });
  });

  it("stays inert when hydrated regardless of electron profile drift", () => {
    expect(
      resolveBootstrapProfile({
        alreadyHydrated: true,
        current: "work",
        electronProfile: "default",
        queryData: "default",
      }),
    ).toEqual({ next: null, hydrated: true });
  });

  describe("electron mode (first run)", () => {
    it("hydrates the atom to the runtime profile when atom is still default", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "default",
          electronProfile: "other",
          queryData: undefined,
        }),
      ).toEqual({ next: "other", hydrated: true });
    });

    it("no-ops but marks hydrated when runtime is already default", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "default",
          electronProfile: "default",
          queryData: undefined,
        }),
      ).toEqual({ next: null, hydrated: true });
    });

    it("does not overwrite a non-default atom from the runtime value", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "other",
          electronProfile: "default",
          queryData: undefined,
        }),
      ).toEqual({ next: null, hydrated: true });
    });
  });

  describe("web mode (first run)", () => {
    it("waits (not hydrated) until the backend sticky arrives", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "default",
          electronProfile: undefined,
          queryData: undefined,
        }),
      ).toEqual({ next: null, hydrated: false });
    });

    it("hydrates the atom from the backend sticky once it loads", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "default",
          electronProfile: undefined,
          queryData: "other",
        }),
      ).toEqual({ next: "other", hydrated: true });
    });

    it("no-ops but marks hydrated when the backend sticky is also default", () => {
      expect(
        resolveBootstrapProfile({
          alreadyHydrated: false,
          current: "default",
          electronProfile: undefined,
          queryData: "default",
        }),
      ).toEqual({ next: null, hydrated: true });
    });
  });
});
