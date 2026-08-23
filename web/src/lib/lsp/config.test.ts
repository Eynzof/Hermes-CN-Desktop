import { describe, expect, it } from "vitest";
import { loadLspConfig } from "./config";

describe("loadLspConfig", () => {
  it("parses a fully-specified config", () => {
    const config = loadLspConfig({
      enabled: true,
      waitMode: "full",
      waitTimeout: 15,
      installStrategy: "auto",
      idleTimeout: 300,
      servers: {
        typescript: {
          command: ["typescript-language-server", "--stdio"],
          env: { NODE_OPTIONS: "--max-old-space-size=2048" },
          disabled: false,
        },
      },
    });
    expect(config).toMatchObject({
      enabled: true,
      waitMode: "full",
      waitTimeout: 15,
      installStrategy: "auto",
      idleTimeout: 300,
    });
    expect(config.servers.typescript).toMatchObject({
      command: ["typescript-language-server", "--stdio"],
      env: { NODE_OPTIONS: "--max-old-space-size=2048" },
      disabled: false,
    });
  });

  it("fills defaults for a partial config", () => {
    const config = loadLspConfig({});
    expect(config).toEqual({
      enabled: true,
      waitMode: "document",
      waitTimeout: 5,
      installStrategy: "manual",
      idleTimeout: 600,
      servers: {},
    });
  });

  it("rejects an undefined input (config must be an object)", () => {
    expect(() => loadLspConfig(undefined)).toThrow();
  });

  it("accepts per-server initializationOptions", () => {
    const config = loadLspConfig({
      servers: {
        python: { initializationOptions: { analysis: { diagnosticMode: "openFilesOnly" } } },
      },
    });
    expect(config.servers.python?.initializationOptions).toEqual({
      analysis: { diagnosticMode: "openFilesOnly" },
    });
  });

  it("rejects invalid enum values", () => {
    expect(() => loadLspConfig({ waitMode: "instant" })).toThrow();
    expect(() => loadLspConfig({ installStrategy: "sometimes" })).toThrow();
  });

  it("rejects wrong-typed fields", () => {
    expect(() => loadLspConfig({ enabled: "yes" })).toThrow();
    expect(() => loadLspConfig({ waitTimeout: "fast" })).toThrow();
    expect(() => loadLspConfig({ servers: "none" })).toThrow();
  });

  it("rejects invalid server entries", () => {
    expect(() => loadLspConfig({ servers: { broken: { command: "not-an-array" } } })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => loadLspConfig("config")).toThrow();
    expect(() => loadLspConfig(42)).toThrow();
    expect(() => loadLspConfig(null)).toThrow();
  });
});
