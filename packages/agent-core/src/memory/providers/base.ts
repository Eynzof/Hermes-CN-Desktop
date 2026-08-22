/**
 * Base HTTP adapter for external memory providers.
 *
 * Bundles common fetch plumbing, JSON body handling, and error conversion.  The
 * fetch implementation is injectable so tests can assert request shapes without
 * touching the network.
 */

import { ProviderError } from "../../errors.js";

export interface HttpMemoryProviderOptions {
  /** Base URL for the provider API. */
  baseUrl: string;
  /** Optional API key / bearer token. */
  apiKey?: string;
  /** Optional extra headers merged into every request. */
  extraHeaders?: Record<string, string>;
  /** Inject a custom fetch for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Normalized HTTP request record used by tests. */
export interface HttpMemoryRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export abstract class HttpMemoryProvider {
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: HttpMemoryProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Build a normalized request record without executing it. */
  buildRequest(path: string, init: RequestInit): HttpMemoryRequest {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        // leave body as-is if it is not JSON
      }
    }

    return {
      url: `${this.baseUrl}${path}`,
      method: init.method ?? "GET",
      headers,
      body,
    };
  }

  /** Execute an HTTP request, throwing `ProviderError` on non-OK responses. */
  protected async request(path: string, init: RequestInit): Promise<Response> {
    const req = this.buildRequest(path, init);
    const headers = new Headers(req.headers);
    const response = await this.fetchImpl(req.url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `External memory request failed: ${response.status} ${response.statusText} ${text}`,
        this.constructor.name,
        response.status,
      );
    }

    return response;
  }

  /** POST helper that JSON-serializes the body. */
  protected async post(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** DELETE helper. */
  protected async del(path: string): Promise<Response> {
    return this.request(path, { method: "DELETE" });
  }
}
