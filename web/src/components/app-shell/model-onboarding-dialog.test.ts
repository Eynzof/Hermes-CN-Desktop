import { describe, expect, it } from "vitest";
import {
  hasConfiguredModel,
  shouldShowModelOnboarding,
} from "./model-onboarding-dialog";

describe("model onboarding dialog", () => {
  it("requires both provider and model before treating setup as complete", () => {
    expect(hasConfiguredModel(undefined)).toBe(false);
    expect(hasConfiguredModel({ provider: "deepseek", model: "" })).toBe(false);
    expect(hasConfiguredModel({ provider: "", model: "deepseek-chat" })).toBe(false);
    expect(hasConfiguredModel({ provider: " deepseek ", model: " deepseek-chat " })).toBe(true);
  });

  it("shows on the workspace only when model setup still needs attention", () => {
    expect(shouldShowModelOnboarding({
      configured: false,
      dismissed: false,
      isError: false,
      isLoading: false,
      pathname: "/",
    })).toBe(true);

    for (const pathname of ["/models", "/models/custom", "/connection", "/console"]) {
      expect(shouldShowModelOnboarding({
        configured: false,
        dismissed: false,
        isError: false,
        isLoading: false,
        pathname,
      })).toBe(false);
    }
  });

  it("never blocks the workspace while loading, failed, configured, or dismissed", () => {
    const base = {
      configured: false,
      dismissed: false,
      isError: false,
      isLoading: false,
      pathname: "/",
    };

    expect(shouldShowModelOnboarding({ ...base, isLoading: true })).toBe(false);
    expect(shouldShowModelOnboarding({ ...base, isError: true })).toBe(false);
    expect(shouldShowModelOnboarding({ ...base, configured: true })).toBe(false);
    expect(shouldShowModelOnboarding({ ...base, dismissed: true })).toBe(false);
  });
});
