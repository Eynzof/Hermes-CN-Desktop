import { describe, expect, it } from "vitest";
import { classifyApiError } from "./error-classifier";

describe("classifyApiError", () => {
  it("classifies 429 and rate-limit wording as retryable rate_limit", () => {
    expect(classifyApiError(new Error("HTTP 429 Too Many Requests"))).toMatchObject({
      reason: "rate_limit",
      retryable: true,
      shouldFallback: true,
      shouldRotateCredential: true,
    });
    expect(classifyApiError("rate limit exceeded").reason).toBe("rate_limit");
    expect(classifyApiError({ message: "too many requests" }).reason).toBe("rate_limit");
    expect(classifyApiError({ status: 429 }).reason).toBe("rate_limit");
  });

  it("classifies billing/quota failures as retryable billing", () => {
    expect(classifyApiError("402 payment required")).toMatchObject({
      reason: "billing",
      retryable: true,
      shouldFallback: true,
      shouldRotateCredential: true,
    });
    expect(classifyApiError(new Error("billing problem on your account")).reason).toBe("billing");
    expect(classifyApiError("monthly quota exhausted").reason).toBe("billing");
    expect(classifyApiError("insufficient balance").reason).toBe("billing");
  });

  it("classifies 401/403 as non-retryable auth", () => {
    expect(classifyApiError(new Error("HTTP 401 Unauthorized"))).toMatchObject({
      reason: "auth",
      retryable: false,
      shouldFallback: true,
      shouldRotateCredential: true,
    });
    expect(classifyApiError({ status: 403, message: "forbidden" }).reason).toBe("auth");
  });

  it("classifies 5xx as retryable server_error without credential rotation", () => {
    for (const code of ["500", "502", "503", "504"]) {
      expect(classifyApiError(new Error(`HTTP ${code} upstream error`))).toMatchObject({
        reason: "server_error",
        retryable: true,
        shouldFallback: true,
        shouldRotateCredential: false,
      });
    }
  });

  it("classifies timeouts as retryable timeout", () => {
    expect(classifyApiError(new Error("request timed out after 30s"))).toMatchObject({
      reason: "timeout",
      retryable: true,
      shouldFallback: true,
      shouldRotateCredential: false,
    });
    expect(classifyApiError("connect ETIMEDOUT 1.2.3.4:443").reason).toBe("timeout");
  });

  it("returns unknown for unmatched errors with no failover hints", () => {
    const error = new Error("something odd happened");
    error.stack = "Error: something odd happened"; // controlled stack: vitest runner frames contain 'timeout'
    expect(classifyApiError(error)).toEqual({
      reason: "unknown",
      retryable: false,
      shouldFallback: false,
      shouldRotateCredential: false,
    });
    expect(classifyApiError(null)).toMatchObject({ reason: "unknown" });
    expect(classifyApiError(undefined)).toMatchObject({ reason: "unknown" });
    expect(classifyApiError(12345)).toMatchObject({ reason: "unknown" });
  });

  it("searches the error stack for hints", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n  at <anonymous>:1:1\n  at fetch (429 rate limit)";
    expect(classifyApiError(error).reason).toBe("rate_limit");
  });

  it("is case-insensitive", () => {
    expect(classifyApiError("RATE LIMIT EXCEEDED").reason).toBe("rate_limit");
    expect(classifyApiError(new Error("UNAUTHORIZED")).reason).toBe("auth");
  });

  it("applies first-match precedence (429 before auth before 5xx)", () => {
    expect(classifyApiError("429 forbidden").reason).toBe("rate_limit");
    expect(classifyApiError("401 timeout").reason).toBe("auth");
    expect(classifyApiError("500 timeout").reason).toBe("server_error");
  });

  it("stringifies plain objects before matching", () => {
    expect(classifyApiError({ status: 429, body: "quota" }).reason).toBe("rate_limit");
  });
});
