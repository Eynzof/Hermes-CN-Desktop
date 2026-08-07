// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/fs-client.ts — MemOsFileSystemClient: typed wrapper over the
// MemOS file-system service REST API (mem_filesys), ported from WanderMemory
// `web/app/src/api/fs_client.ts`. Uses the same relative/absolute transport
// split as MemOsRestClient: relative origin → fetchJSON (dev same-origin
// /v1/fs proxy), absolute http(s) origin → fetchExternalJSON.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchExternalJSON, fetchJSON } from '../transport';
import { resolveEndpoints } from './endpoints';
import { adaptTransportError, isAbsoluteRequestUrl, resolveRequestUrl } from './rest';
import type { ScanResponse, UpdateIngestRequest, UpdateIngestResponse } from './types';

const NO_LLM_TIMEOUT_MS = 10_000;
const FS_BACKEND_HINT =
  ' — is the file-system API server running? (default http://127.0.0.1:18402)';

export interface FileSystemClient {
  readonly mode: 'live' | 'demo';
  health(): Promise<{ status: string; service?: string }>;
  scan(directory: string): Promise<ScanResponse>;
  updateIngest(
    directory: string,
    rel_path: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<UpdateIngestResponse>;
}

export class MemOsFileSystemClient implements FileSystemClient {
  readonly mode = 'live' as const;
  readonly origin: string;

  constructor(origin: string = resolveEndpoints().fsOrigin) {
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
      // Non-JSON error bodies are common here — the Vite dev proxy replies with
      // text/plain 500 when the FS server (:18402) is not running. Surface the
      // raw body plus an actionable hint instead of a cryptic message.
      throw adaptTransportError(err, FS_BACKEND_HINT);
    }
  }

  health(): Promise<{ status: string; service?: string }> {
    return this.request('GET', '/health');
  }

  scan(directory: string): Promise<ScanResponse> {
    return this.request('POST', '/scan', { directory }, NO_LLM_TIMEOUT_MS);
  }

  updateIngest(
    directory: string,
    rel_path: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<UpdateIngestResponse> {
    const body: UpdateIngestRequest = {
      directory,
      rel_path,
      text,
      ...(metadata ? { metadata } : {}),
    };
    return this.request('POST', '/update_ingest', body, null);
  }
}
