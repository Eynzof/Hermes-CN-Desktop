import { describe, expect, it } from "vitest";
import {
  buildLogJsonl,
  buildLogText,
  createLogExportFileName,
  filterLogLines,
  parseLogsSearchParams,
} from "./logs-viewer";

describe("logs-viewer helpers", () => {
  it("falls back to safe defaults for invalid query values", () => {
    const state = parseLogsSearchParams(new URLSearchParams("file=evil&level=nope&component=bad&lines=999&live=no&redact=0"));

    expect(state).toMatchObject({
      file: "agent",
      level: "ALL",
      component: "all",
      lines: 200,
      live: false,
      redact: false,
    });
  });

  it("accepts source as an alias for component", () => {
    const state = parseLogsSearchParams(new URLSearchParams("source=gateway&level=error&lines=500&q=timeout"));

    expect(state.component).toBe("gateway");
    expect(state.level).toBe("ERROR");
    expect(state.lines).toBe(500);
    expect(state.q).toBe("timeout");
  });

  it("filters visible lines by all search terms case-insensitively", () => {
    const lines = [
      "INFO gateway connected",
      "ERROR gateway token expired",
      "ERROR agent timeout",
    ];

    expect(filterLogLines(lines, "error gateway")).toEqual(["ERROR gateway token expired"]);
  });

  it("builds redacted plain text for copying and .log export", () => {
    const text = buildLogText(["ERROR token=secret-value Bearer abcdefghij"], { redact: true });

    expect(text).toBe("ERROR token=*** Bearer ***\n");
  });

  it("builds JSONL with parsed metadata", () => {
    const jsonl = buildLogJsonl(["2026-06-07 10:11:12 [gateway] WARN token=secret-value"], {
      file: "gateway",
      redact: true,
    });
    const row = JSON.parse(jsonl.trim()) as Record<string, unknown>;

    expect(row).toMatchObject({
      file: "gateway",
      lineNumber: 1,
      level: "WARNING",
      source: "gateway",
      timestamp: "2026-06-07 10:11:12",
      message: "2026-06-07 10:11:12 [gateway] WARN token=***",
    });
  });

  it("creates deterministic export file names", () => {
    expect(createLogExportFileName(
      { file: "agent", format: "jsonl" },
      new Date("2026-06-07T10:11:12.000Z"),
    )).toBe("hermes-logs-agent-20260607-101112.jsonl");
  });
});
