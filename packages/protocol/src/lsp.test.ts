import { describe, expect, it } from "vitest";
import {
  LspConfigSchema,
  LspDiagnosticSchema,
  LspPositionSchema,
  LspRangeSchema,
  LspServerStatusSchema,
} from "./lsp";

describe("LspPositionSchema", () => {
  it("parses a zero-based position", () => {
    expect(LspPositionSchema.parse({ line: 0, character: 10 })).toEqual({
      line: 0,
      character: 10,
    });
  });

  it("rejects missing line/character or non-numbers", () => {
    expect(LspPositionSchema.safeParse({ line: 1 }).success).toBe(false);
    expect(LspPositionSchema.safeParse({ line: "1", character: 2 }).success).toBe(false);
  });
});

describe("LspRangeSchema", () => {
  it("parses start/end positions", () => {
    const parsed = LspRangeSchema.parse({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    });
    expect(parsed.start.character).toBe(0);
    expect(parsed.end.character).toBe(5);
  });

  it("rejects a range missing its end", () => {
    const result = LspRangeSchema.safeParse({ start: { line: 0, character: 0 } });
    expect(result.success).toBe(false);
  });
});

describe("LspDiagnosticSchema", () => {
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } };

  it("parses a full diagnostic", () => {
    const parsed = LspDiagnosticSchema.parse({
      severity: 1,
      code: "E1101",
      source: "pylance",
      message: "undefined name",
      range,
    });
    expect(parsed.severity).toBe(1);
    expect(parsed.code).toBe("E1101");
    expect(parsed.source).toBe("pylance");
  });

  it("accepts numeric codes and every severity 1..4", () => {
    const parsed = LspDiagnosticSchema.parse({ severity: 4, code: 1234, message: "m", range });
    expect(parsed.code).toBe(1234);
    for (const s of [1, 2, 3, 4]) {
      expect(LspDiagnosticSchema.safeParse({ severity: s, message: "m", range }).success).toBe(true);
    }
  });

  it("rejects out-of-range severities", () => {
    expect(LspDiagnosticSchema.safeParse({ severity: 0, message: "m", range }).success).toBe(false);
    expect(LspDiagnosticSchema.safeParse({ severity: 5, message: "m", range }).success).toBe(false);
  });

  it("rejects a diagnostic without message or range", () => {
    expect(LspDiagnosticSchema.safeParse({ severity: 1, range }).success).toBe(false);
    expect(LspDiagnosticSchema.safeParse({ severity: 1, message: "m" }).success).toBe(false);
  });
});

describe("LspConfigSchema", () => {
  it("applies defaults to an empty config", () => {
    const parsed = LspConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: true,
      waitMode: "document",
      waitTimeout: 5,
      installStrategy: "manual",
      idleTimeout: 600,
      servers: {},
    });
  });

  it("parses a full config with per-server settings", () => {
    const parsed = LspConfigSchema.parse({
      enabled: false,
      waitMode: "full",
      waitTimeout: 30,
      installStrategy: "auto",
      idleTimeout: 120,
      servers: {
        pylance: {
          disabled: true,
          command: ["pyright-langserver", "--stdio"],
          env: { PYTHONPATH: "/venv" },
          initializationOptions: { inlayHints: true },
        },
      },
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.waitMode).toBe("full");
    expect(parsed.servers.pylance?.command).toEqual(["pyright-langserver", "--stdio"]);
    expect(parsed.servers.pylance?.initializationOptions).toEqual({ inlayHints: true });
  });

  it("rejects invalid enums and out-of-range numbers", () => {
    expect(LspConfigSchema.safeParse({ waitMode: "edits" }).success).toBe(false);
    expect(LspConfigSchema.safeParse({ installStrategy: "yes" }).success).toBe(false);
    expect(LspConfigSchema.safeParse({ waitTimeout: "5" }).success).toBe(false);
  });
});

describe("LspServerStatusSchema", () => {
  it("parses installed status with optional binary", () => {
    expect(LspServerStatusSchema.parse({ serverId: "pylance", installed: true })).toEqual({
      serverId: "pylance",
      installed: true,
    });
    const parsed = LspServerStatusSchema.parse({
      serverId: "pylance",
      binary: "/usr/bin/pyright",
      installed: false,
    });
    expect(parsed.binary).toBe("/usr/bin/pyright");
  });

  it("rejects a missing serverId or installed flag", () => {
    expect(LspServerStatusSchema.safeParse({ installed: true }).success).toBe(false);
    expect(LspServerStatusSchema.safeParse({ serverId: "x" }).success).toBe(false);
  });
});
