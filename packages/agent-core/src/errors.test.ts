import { describe, expect, it } from "vitest";
import {
  AgentAbortError,
  AgentError,
  isAbortError,
  isRecoverableError,
  ProviderError,
  ToolError,
} from "./errors.js";

describe("AgentError", () => {
  it("stores code and recoverable flag and sets the name", () => {
    const error = new AgentError("boom", "generic");
    expect(error.message).toBe("boom");
    expect(error.code).toBe("generic");
    expect(error.recoverable).toBe(false);
    expect(error.name).toBe("AgentError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AgentError);
  });

  it("accepts an explicit recoverable flag", () => {
    const error = new AgentError("retry me", "transient", true);
    expect(error.recoverable).toBe(true);
  });

  it("defaults recoverable to false", () => {
    const error = new AgentError("nope", "permanent");
    expect(error.recoverable).toBe(false);
  });
});

describe("AgentAbortError", () => {
  it("uses code aborted and is not recoverable", () => {
    const error = new AgentAbortError();
    expect(error.message).toBe("Turn was interrupted");
    expect(error.code).toBe("aborted");
    expect(error.recoverable).toBe(false);
    expect(error.name).toBe("AgentAbortError");
    expect(error).toBeInstanceOf(AgentError);
  });

  it("accepts a custom message", () => {
    const error = new AgentAbortError("Stopped by user");
    expect(error.message).toBe("Stopped by user");
  });
});

describe("ToolError", () => {
  it("uses code tool_error and is recoverable", () => {
    const error = new ToolError("tool blew up");
    expect(error.code).toBe("tool_error");
    expect(error.recoverable).toBe(true);
    expect(error.name).toBe("ToolError");
    expect(error.toolName).toBeUndefined();
  });

  it("records the tool name", () => {
    const error = new ToolError("bad args", "write_file");
    expect(error.toolName).toBe("write_file");
    expect(error.message).toBe("bad args");
  });
});

describe("ProviderError", () => {
  it("uses code provider_error with no status code", () => {
    const error = new ProviderError("upstream failed");
    expect(error.code).toBe("provider_error");
    expect(error.provider).toBeUndefined();
    expect(error.statusCode).toBeUndefined();
    expect(error.name).toBe("ProviderError");
  });

  it("is recoverable when the status code is undefined (unknown classification)", () => {
    expect(new ProviderError("x").recoverable).toBe(true);
  });

  it("is recoverable for 5xx status codes", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(new ProviderError("x", "openai", status).recoverable).toBe(true);
    }
  });

  it("is recoverable for 429 (rate limited)", () => {
    expect(new ProviderError("x", "openai", 429).recoverable).toBe(true);
  });

  it("is not recoverable for 4xx status codes other than 429", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(new ProviderError("x", "openai", status).recoverable).toBe(false);
    }
  });

  it("records provider and status code", () => {
    const error = new ProviderError("quota", "anthropic", 429);
    expect(error.provider).toBe("anthropic");
    expect(error.statusCode).toBe(429);
  });
});

describe("isAbortError", () => {
  it("returns true only for AgentAbortError instances", () => {
    expect(isAbortError(new AgentAbortError())).toBe(true);
    expect(isAbortError(new AgentError("x", "aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError("aborted")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("isRecoverableError", () => {
  it("returns the recoverable flag for AgentError instances", () => {
    expect(isRecoverableError(new AgentError("x", "c", true))).toBe(true);
    expect(isRecoverableError(new AgentError("x", "c", false))).toBe(false);
    expect(isRecoverableError(new ToolError("x"))).toBe(true);
    expect(isRecoverableError(new ProviderError("x", "o", 503))).toBe(true);
    expect(isRecoverableError(new ProviderError("x", "o", 400))).toBe(false);
    expect(isRecoverableError(new AgentAbortError())).toBe(false);
  });

  it("returns false for non-AgentError values", () => {
    expect(isRecoverableError(new Error("plain"))).toBe(false);
    expect(isRecoverableError("string")).toBe(false);
    expect(isRecoverableError(undefined)).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
    expect(isRecoverableError({ recoverable: true })).toBe(false);
  });
});
