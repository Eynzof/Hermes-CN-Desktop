import { describe, it, expect, beforeEach } from "vitest";
import { capabilityStore, checkCapability, credentialGates, envGate, requireEnv } from "./gates.js";

describe("envGate", () => {
  it("passes when all keys are present and non-empty", () => {
    expect(envGate(["A"], { env: { A: "x" } })).toBe(true);
  });

  it("fails when a key is missing", () => {
    expect(envGate(["A", "B"], { env: { A: "x" } })).toBe(false);
  });

  it("fails when a key is empty", () => {
    expect(envGate(["A"], { env: { A: "" } })).toBe(false);
  });
});

describe("checkCapability", () => {
  beforeEach(() => {
    capabilityStore.invalidate();
  });

  it("caches a passing probe", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return true;
    };
    await checkCapability("test-pass", probe);
    await checkCapability("test-pass", probe);
    expect(calls).toBe(1);
  });

  it("caches a failing probe", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return false;
    };
    await checkCapability("test-fail", probe);
    await checkCapability("test-fail", probe);
    expect(calls).toBe(1);
  });

  it("graces a flaky false after a previous true", async () => {
    let status = true;
    const probe = () => status;
    await checkCapability("test-flake", probe);
    status = false;
    const stillOk = await checkCapability("test-flake", probe);
    // Because TTL cache returns the previous true immediately
    expect(stillOk).toBe(true);
  });
});

describe("credentialGates", () => {
  it("x_search requires xAI or X credentials", () => {
    expect(credentialGates.x_search({ env: { XAI_API_KEY: "x" } })).toBe(true);
    expect(credentialGates.x_search({ env: {} })).toBe(false);
  });

  it("homeassistant requires token", () => {
    expect(credentialGates.homeassistant({ env: { HOME_ASSISTANT_TOKEN: "x" } })).toBe(true);
    expect(credentialGates.homeassistant({ env: {} })).toBe(false);
  });

  it("requireEnv builder works", () => {
    const gate = requireEnv("KEY");
    expect(gate({ env: { KEY: "x" } })).toBe(true);
    expect(gate({ env: {} })).toBe(false);
  });
});
