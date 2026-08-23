import { describe, expect, it, vi } from "vitest";
import "./catalog.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["meet_join", "meet_status", "meet_transcript", "meet_leave", "meet_say", "meet_setup"];

function invokeOk(value: unknown) {
  return vi.fn(async (_command: string, _args: Record<string, unknown>) => value);
}

describe("meet catalog registration", () => {
  it("registers the six Meet tools under google_meet", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("google_meet");
      expect(entry!.tags).toContain("google_meet");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("builds a meet_join schema requiring url with a defaulted mode", () => {
    const schema = registry.get("meet_join")!.schema;
    expect(schema.required).toContain("url");
    expect(schema.properties).toHaveProperty("url");
    const mode = schema.properties?.mode as { enum?: string[] } | undefined;
    expect(mode?.enum).toEqual(["transcribe", "realtime"]);
  });
});

describe("meet tool dispatch", () => {
  it("meet_join requires a URL", async () => {
    const res = await registry.dispatch("meet_join", {}, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("url is required");
  });

  it("meet_join rejects unsafe or malformed URLs", async () => {
    const res = await registry.dispatch("meet_join", { url: "https://evil.example.com/x" }, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid or unsafe Meet URL");
  });

  it("meet_join invokes the Rust runtime with parsed arguments", async () => {
    const invoke = invokeOk({ success: true, meeting_id: "abcdefghij", out_dir: "/tmp/meet" });
    const res = await registry.dispatch(
      "meet_join",
      { url: "https://meet.google.com/abc-defg-hij", guest_name: "Bot", duration_minutes: "30m" },
      { invoke },
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.success).toBe(true);
    expect(parsed.meeting_id).toBe("abcdefghij");
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("meet_join");
    expect(args!.meetingId).toBe("abcdefghij");
    expect(args!.guestName).toBe("Bot");
    expect(args!.durationMinutes).toBe(30);
    expect(args!.mode).toBe("transcribe");
  });

  it("meet_join reports an error when the runtime is unavailable", async () => {
    const res = await registry.dispatch("meet_join", { url: "https://meet.google.com/abc-defg-hij" }, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("requires the desktop Rust runtime");
  });

  it("meet_status passes through success/failure from the runtime", async () => {
    const invoke = invokeOk({ success: true, active: true, status: "in_meeting" });
    const res = await registry.dispatch("meet_status", { meeting_id: "abcdefghij" }, { invoke });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.active).toBe(true);
    expect(parsed.status).toBe("in_meeting");

    const failInvoke = invokeOk({ success: false, error: "not in a meeting" });
    const failRes = await registry.dispatch("meet_status", {}, { invoke: failInvoke });
    expect(failRes.isError).toBe(true);
    expect(failRes.content).toContain("not in a meeting");
  });

  it("meet_transcript returns line count", async () => {
    const invoke = invokeOk({ success: true, lines: ["a", "b", "c"] });
    const res = await registry.dispatch("meet_transcript", { last: 2 }, { invoke });
    const parsed = JSON.parse(res.content);
    expect(parsed.line_count).toBe(3);
    expect(parsed.lines).toEqual(["a", "b", "c"]);
    expect(invoke.mock.calls[0][1]!.last).toBe(2);
  });

  it("meet_say reports deferred realtime speech without invoke", async () => {
    const res = await registry.dispatch("meet_say", { text: "hello" }, {});
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("transcribe mode");
  });

  it("meet_say requires text", async () => {
    const res = await registry.dispatch("meet_say", {}, {});
    const parsed = JSON.parse(res.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("text is required");
  });

  it("meet_leave forwards the leave reason", async () => {
    const invoke = invokeOk({ success: true, meeting_id: "abcdefghij" });
    const res = await registry.dispatch("meet_leave", { reason: "done" }, { invoke });
    expect(res.isError).toBeFalsy();
    expect(invoke.mock.calls[0][1]!.reason).toBe("done");
  });
});
