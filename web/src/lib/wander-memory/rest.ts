// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/rest.ts — MemOsRestClient: typed wrapper over the §4.1 REST
// API, built on the Hermes transport (fetchJSON / fetchExternalJSON) instead
// of raw fetch.
//
// Transport split:
//   • relative origin ("" or "/v1") → fetchJSON with the path as-is
//     (dev same-origin Vite proxy; browser never makes a cross-origin call)
//   • absolute http(s) origin → fetchExternalJSON with the joined URL
//     (MemOS runs externally; its API server has CORS off by default, so the
//     Rust external_request proxy is the reliable carrier in the desktop)
//
// Rules implemented (§5.2):
//   • one request<T>() helper; documented error body → ApiError; defensive
//     fallback when the body is not the documented shape
//   • DELETE 204 / empty body is success-with-no-payload
//   • 10 s timeout on no-LLM endpoints; NO client timeout on /dialogues, /chat
//   • URLSearchParams for query encoding — never string-concatenation
// ─────────────────────────────────────────────────────────────────────────────

import { fetchExternalJSON, fetchJSON } from '../transport';
import { ApiError } from './errors';
import { resolveEndpoints } from './endpoints';
import type {
  AddDialogueResponse,
  AddMemoryResponse,
  BackendsResponse,
  ChatResponse,
  ContextResponse,
  GetMemoryResponse,
  HealthResponse,
  MaintenanceResponse,
  ModelsResponse,
  SearchResponse,
} from './types';

export const DEFAULT_API_ORIGIN = 'http://127.0.0.1:18400';
const NO_LLM_TIMEOUT_MS = 10_000;
const INTROSPECTION_TIMEOUT_MS = 3_000;

/**
 * Join an origin ("" | "/v1" | "http://host:port" | "http://host:port/v1") with
 * a §4.1 path segment to produce the full request URL.
 */
export function resolveRequestUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '');
  if (base === '' || base === '/v1') return `/v1${path}`;
  const trimmed = base.endsWith('/v1') ? base.slice(0, base.length - 3) : base;
  return `${trimmed}/v1${path}`;
}

export function isAbsoluteRequestUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isAbortLike(err: Error): boolean {
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * Convert a transport failure into a structured ApiError (plan Appendix A.10):
 *   • `Error("HTTP <status>: <body>")` → parse { error: { code, message } }
 *     from the body; missing/undocumented body → 5xx = "internal", else
 *     "unknown"
 *   • timeout/abort → "network_failure"
 *   • anything else (no response) → "network_failure" (ApiError.network)
 *   • ApiError → passthrough
 */
export function adaptTransportError(err: unknown, hint?: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    if (isAbortLike(err)) {
      return new ApiError('network_failure', 'request timed out — aborted client-side', null);
    }
    const m = /^HTTP (\d+): ([\s\S]*)$/.exec(err.message);
    if (m) {
      const status = Number(m[1]);
      const body = m[2];
      if (status === 0 || status === 408) {
        return new ApiError(
          'network_failure',
          'MemOS service is offline — start MemOS or update endpoint settings below',
          null,
        );
      }
      try {
        const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } } | null;
        if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.code === 'string') {
          return new ApiError(
            parsed.error.code,
            typeof parsed.error.message === 'string' ? parsed.error.message : parsed.error.code,
            status,
          );
        }
      } catch {
        // non-JSON body — handled below
      }
      // defensive: body isn't the documented shape — never crash the UI
      const bodyHint = body ? `: ${body.slice(0, 160)}` : ' (empty body)';
      return new ApiError(
        status >= 500 ? 'internal' : 'unknown',
        `HTTP ${status}: unexpected error body${bodyHint}${hint ?? ''}`,
        status,
      );
    }
    return ApiError.network(err);
  }
  return new ApiError('unknown', `unknown error: ${String(err)}`, null);
}

export class MemOsRestClient {
  readonly origin: string;

  constructor(origin: string = resolveEndpoints().apiOrigin) {
    this.origin = origin;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number | null = NO_LLM_TIMEOUT_MS,
  ): Promise<T> {
    const url = resolveRequestUrl(this.origin, path);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    if (timeoutMs !== null) init.signal = AbortSignal.timeout(timeoutMs);
    try {
      if (isAbsoluteRequestUrl(url)) {
        return await fetchExternalJSON<T>(url, init);
      }
      return await fetchJSON<T>(url, init);
    } catch (err) {
      // DELETE 204 returns an empty body; the transport parses it as JSON and
      // throws SyntaxError — but a non-ok status would have thrown an HTTP
      // error first, so a parse failure here means success-with-no-payload.
      if (method === 'DELETE' && err instanceof SyntaxError) {
        return undefined as T;
      }
      throw adaptTransportError(err);
    }
  }

  // ── §4.1 endpoints ────────────────────────────────────────────────────────
  health(): Promise<HealthResponse> {
    return this.request('GET', '/health', undefined, INTROSPECTION_TIMEOUT_MS);
  }

  backends(): Promise<BackendsResponse> {
    return this.request('GET', '/backends', undefined, INTROSPECTION_TIMEOUT_MS);
  }

  models(): Promise<ModelsResponse> {
    return this.request('GET', '/models', undefined, INTROSPECTION_TIMEOUT_MS);
  }

  /** LLM path: extraction + N collision calls — no client timeout (§5.2). */
  addDialogue(dialogue: string): Promise<AddDialogueResponse> {
    return this.request('POST', '/dialogues', { dialogue }, null);
  }

  addMemory(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse> {
    return this.request('POST', '/memories', { text, ...(metadata ? { metadata } : {}) });
  }

  search(query: string, topK?: number): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    qs.set('q', query);
    if (topK !== undefined) qs.set('top_k', String(topK));
    return this.request('GET', `/memories?${qs.toString()}`);
  }

  list(): Promise<SearchResponse> {
    return this.request('GET', '/memories');
  }

  get(id: string): Promise<GetMemoryResponse> {
    return this.request('GET', `/memories/${encodeURIComponent(id)}`);
  }

  /** 204 empty body on success; throws ApiError('not_found') on 404. */
  async delete(id: string): Promise<void> {
    await this.request<void>('DELETE', `/memories/${encodeURIComponent(id)}`);
  }

  context(query: string, topK?: number): Promise<ContextResponse> {
    return this.request('POST', '/context', { query, ...(topK !== undefined ? { top_k: topK } : {}) });
  }

  /** LLM path — no client timeout (§5.2). */
  chat(query: string): Promise<ChatResponse> {
    return this.request('POST', '/chat', { query }, null);
  }

  maintenance(): Promise<MaintenanceResponse> {
    return this.request('POST', '/maintenance', {});
  }
}
