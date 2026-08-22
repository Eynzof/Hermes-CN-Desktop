/**
 * HTTP adapter for web search/extract providers.
 * In Tauri production this routes through the Rust `web_provider_request` command
 * (longer timeouts, larger bodies, SSRF guards). In dev / browser it falls back to
 * a plain `fetch` so tests can stub the global.
 */

import { runtime } from "@/lib/runtime.js";

export interface WebRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  followRedirects?: boolean;
}

export interface WebRequestResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function abortError(): DOMException | Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(ms);
  if (!parent) return own;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([own, parent]);
  return own;
}

export async function webRequest(input: WebRequestInput): Promise<WebRequestResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const native = typeof window !== "undefined" ? window.hermesDesktop?.webProviderRequest : undefined;

  if (native) {
    return native({
      path: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body ?? null,
      timeoutSeconds: Math.ceil(timeoutMs / 1000),
      maxBytes: input.maxBytes,
      followRedirects: input.followRedirects,
    });
  }

  // Browser / dev fallback. Do not route dashboard URLs here.
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: timeoutSignal(timeoutMs),
  });

  let body = "";
  try {
    body = await res.text();
  } catch {
    // Some responses have no readable body.
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers,
    body,
  };
}

export async function webRequestJSON<T>(input: WebRequestInput): Promise<T> {
  const result = await webRequest(input);
  if (!result.ok) {
    throw new Error(`HTTP ${result.status}: ${result.body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(result.body) as T;
  } catch (e) {
    throw new Error(`Invalid JSON response from ${input.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function webRequestText(input: WebRequestInput): Promise<string> {
  const result = await webRequest(input);
  if (!result.ok) {
    throw new Error(`HTTP ${result.status}: ${result.body.slice(0, 500)}`);
  }
  return result.body;
}