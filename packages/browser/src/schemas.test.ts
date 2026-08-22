import { describe, expect, it } from "vitest";
import {
  BrowserConfig,
  BrowserBackendKind,
  BrowserSessionRecord,
  BrowserNavigateInput,
  BrowserSnapshotInput,
  BrowserToolResult,
} from "./schemas.js";

describe("BrowserConfig", () => {
  it("applies defaults", () => {
    const cfg = BrowserConfig.parse({});
    expect(cfg.backend).toBe("local");
    expect(cfg.headed).toBe(false);
    expect(cfg.recordSessions).toBe(false);
    expect(cfg.engine).toBe("chromium");
    expect(cfg.autoLocalForPrivateUrls).toBe(true);
    expect(cfg.allowPrivateUrls).toBe(false);
    expect(cfg.dialogPolicy).toBe("auto_dismiss");
    expect(cfg.dialogTimeoutS).toBe(30);
    expect(cfg.commandTimeout).toBe(30);
    expect(cfg.inactivityTimeout).toBe(300);
  });

  it("reads explicit values", () => {
    const cfg = BrowserConfig.parse({
      backend: "browserbase",
      headed: true,
      engine: "lightpanda",
      dialogPolicy: "must_respond",
    });
    expect(cfg.backend).toBe("browserbase");
    expect(cfg.headed).toBe(true);
    expect(cfg.engine).toBe("lightpanda");
    expect(cfg.dialogPolicy).toBe("must_respond");
  });

  it("rejects invalid backend", () => {
    expect(() => BrowserConfig.parse({ backend: "unknown" })).toThrow();
  });
});

describe("BrowserBackendKind", () => {
  it("includes all known backends", () => {
    const kinds = ["local", "cdp", "browserbase", "browser-use", "firecrawl", "camofox", "lightpanda", "agent-browser"];
    for (const kind of kinds) {
      expect(BrowserBackendKind.parse(kind)).toBe(kind);
    }
  });
});

describe("BrowserSessionRecord", () => {
  it("round-trips minimal record", () => {
    const record = BrowserSessionRecord.parse({
      taskId: "task-1",
      backend: "local",
    });
    expect(record.taskId).toBe("task-1");
    expect(record.backend).toBe("local");
    expect(record.lastActiveAt).toBeTypeOf("number");
  });
});

describe("BrowserNavigateInput", () => {
  it("requires url and accepts optional timeout", () => {
    const input = BrowserNavigateInput.parse({ url: "https://example.com", timeout: 10 });
    expect(input.url).toBe("https://example.com");
    expect(input.timeout).toBe(10);
  });

  it("fails without url", () => {
    expect(() => BrowserNavigateInput.parse({})).toThrow();
  });
});

describe("BrowserToolResult", () => {
  it("validates success shape", () => {
    const result = BrowserToolResult.parse({ success: true, url: "https://example.com" });
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://example.com");
  });
});
