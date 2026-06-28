import { beforeEach, describe, expect, it } from "vitest";
import { debugBus } from "./debug-bus";
import {
  GatewayResultError,
  humanizeGatewayError,
  parseGatewayResult,
} from "./gateway-result";

const passSchema = { parse: (v: unknown) => v as { ok: boolean } };

function zodErrorDouble(): Error {
  const err = Object.assign(new Error('[{"path":["session_id"],"message":"Required"}]'), {
    issues: [{ path: ["session_id"], message: "Required" }],
  });
  err.name = "ZodError";
  return err;
}

// A schema double that throws a ZodError-shaped error, like the real
// `SessionResumeResult.parse` does when `session_id` is missing (#58).
const failSchema = {
  parse: (_v: unknown): { session_id: string } => {
    throw zodErrorDouble();
  },
};

describe("parseGatewayResult", () => {
  beforeEach(() => debugBus.clear());

  it("returns the parsed value on success", () => {
    expect(parseGatewayResult(passSchema, { ok: true }, "session.create")).toEqual({
      ok: true,
    });
  });

  it("throws a friendly GatewayResultError instead of the raw ZodError blob", () => {
    let thrown: unknown;
    try {
      parseGatewayResult(failSchema, { accepted: true, async: true }, "session.resume");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GatewayResultError);
    const err = thrown as GatewayResultError;
    expect(err.method).toBe("session.resume");
    expect(err.message).toContain("session.resume");
    // The infamous raw Zod blob must not reach the user.
    expect(err.message).not.toContain("session_id");
    expect(err.message).not.toContain("Required");
  });

  it("records a redacted gateway debug entry on parse failure", () => {
    expect(() =>
      parseGatewayResult(failSchema, { accepted: true, async: true }, "session.resume"),
    ).toThrow(GatewayResultError);
    const entries = debugBus.snapshot();
    const last = entries[entries.length - 1];
    expect(last?.type).toBe("gateway");
    expect(last?.level).toBe("error");
    expect(last?.summary).toContain("session.resume");
  });
});

describe("humanizeGatewayError", () => {
  it("passes through an already-friendly GatewayResultError message", () => {
    expect(humanizeGatewayError(new GatewayResultError("自定义友好消息", "session.create"))).toBe(
      "自定义友好消息",
    );
  });

  it("converts a raw ZodError into a friendly message without leaking fields", () => {
    const msg = humanizeGatewayError(zodErrorDouble());
    expect(msg).not.toContain("session_id");
    expect(msg).toContain("无法识别");
  });

  it("localizes timeout errors", () => {
    const message = humanizeGatewayError(new Error("RPC timeout: session.resume"));
    expect(message).toContain("超时");
    expect(message).toContain("LM Studio");
    // The dev-facing jargon (64K context, OOM, 显存) is intentionally dropped.
    expect(message).not.toContain("OOM");
  });

  it("localizes connection-closed errors", () => {
    expect(humanizeGatewayError(new Error("WebSocket closed"))).toContain("连接已断开");
    expect(humanizeGatewayError(new Error("WebSocket connection lost"))).toContain("连接已断开");
  });

  it("passes through meaningful backend error messages unchanged", () => {
    expect(humanizeGatewayError(new Error("unknown method: foo"))).toBe("unknown method: foo");
  });
});
