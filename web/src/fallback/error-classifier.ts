import type { ClassifiedError, FailoverReason } from "./types.js";

export function classifyApiError(error: unknown): ClassifiedError {
  let text = "";
  if (error instanceof Error) {
    text = (error.message + " " + (error.stack ?? "")).toLowerCase();
  } else if (error && typeof error === "object") {
    text = JSON.stringify(error).toLowerCase();
  } else {
    text = String(error).toLowerCase();
  }
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) {
    return { reason: "rate_limit", retryable: true, shouldFallback: true, shouldRotateCredential: true };
  }
  if (text.includes("402") || text.includes("billing") || text.includes("quota") || text.includes("insufficient")) {
    return { reason: "billing", retryable: true, shouldFallback: true, shouldRotateCredential: true };
  }
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden")) {
    return { reason: "auth", retryable: false, shouldFallback: true, shouldRotateCredential: true };
  }
  if (text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) {
    return { reason: "server_error", retryable: true, shouldFallback: true, shouldRotateCredential: false };
  }
  if (text.includes("timeout") || text.includes("etimedout")) {
    return { reason: "timeout", retryable: true, shouldFallback: true, shouldRotateCredential: false };
  }
  return { reason: "unknown", retryable: false, shouldFallback: false, shouldRotateCredential: false };
}
