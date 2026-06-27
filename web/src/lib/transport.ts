import { getDefaultStore } from "jotai";
import { runtime } from "./runtime";
import { debugBus } from "./debug-bus";
import { activeProfileAtom } from "@/stores/ui";
import { AttachmentUploadResult } from "@hermes/protocol";
import type { DownloadExternalImageInput, DownloadedImageResult } from "./runtime";

interface Parser<T> {
  parse(value: unknown): T;
}

function profileHeader(): string | null {
  // 读 atom 的当前值（不订阅变化，每次请求时取最新）。"default" 不发 header，
  // 避免给 dashboard 看到无意义的标记。当前上游 dashboard 不读这个 header，
  // 是为支持 multi-profile 路由的 fork 提前布的桩。
  try {
    const profile = getDefaultStore().get(activeProfileAtom);
    if (profile && profile !== "default") return profile;
  } catch {
    // SSR / 测试环境拿不到 store 就忽略
  }
  return null;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  const token = runtime.getSessionToken();
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
    h["X-Hermes-Session-Token"] = token;
  }
  const profile = profileHeader();
  if (profile) h["X-Hermes-Profile"] = profile;
  return h;
}

function authOnlyHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = runtime.getSessionToken();
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
    h["X-Hermes-Session-Token"] = token;
  }
  const profile = profileHeader();
  if (profile) h["X-Hermes-Profile"] = profile;
  return h;
}


function abortError(): DOMException | Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortPromise(signal?: AbortSignal | null): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

export async function raceAbort<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  const aborted = abortPromise(signal);
  if (!aborted) return work;
  // abort 胜出后底层（原生 IPC）的 work 仍在后台跑，若它随后 reject 会变成
  // unhandled rejection——在“快速切换”这一高频场景里尤其刷屏。兜底吞掉它。
  work.catch(() => {});
  return Promise.race([work, aborted]);
}

function shouldUseNativeIpc(path: string): boolean {
  const isLocalDesktopRoute =
    path.startsWith("/__hermes_session_log/") || path.startsWith("/__hermes_cron_runs/");

  if (runtime.platform === "tauri") {
    if (isLocalDesktopRoute && window.hermesDesktop?.request) return true;
    if (!window.__HERMES_RUNTIME__?.apiBaseUrl) return false;
    return true;
  }
  if (runtime.platform !== "electron") return false;
  if (!window.hermesDesktop?.request) return false;
  if (isLocalDesktopRoute) return true;
  if (!window.__HERMES_RUNTIME__?.apiBaseUrl) return false;
  return !path.startsWith("/__hermes_");
}

function reportRestFailure(method: string, target: string, status: number, body: string): void {
  debugBus.push({
    type: "rest",
    level: "error",
    summary: `${method} ${target} → ${status}`,
    payload: { method, url: target, status, body: body.slice(0, 800) },
  });
}

async function fetchViaElectron<T>(
  path: string,
  init?: RequestInit,
  parser?: Parser<T>,
): Promise<T> {
  const signal = init?.signal ?? null;
  throwIfAborted(signal);

  const result = await raceAbort(window.hermesDesktop!.request({
    path,
    method: init?.method,
    headers: authHeaders(init?.headers as Record<string, string>),
    body: typeof init?.body === "string" ? init.body : null,
  }), signal);

  throwIfAborted(signal);

  if (!result.ok) {
    reportRestFailure(init?.method ?? "GET", path, result.status, result.body);
    throw new Error(`HTTP ${result.status}: ${result.body}`);
  }

  const data = result.body ? JSON.parse(result.body) : null;
  return parser ? parser.parse(data) : data as T;
}

export async function fetchJSON<T>(
  path: string,
  init?: RequestInit,
  parser?: Parser<T>,
): Promise<T> {
  if (shouldUseNativeIpc(path)) {
    return fetchViaElectron(path, init, parser);
  }

  const res = await fetch(runtime.getApiUrl(path), {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string>),
  });
  if (!res.ok) {
    const body = await res.text();
    reportRestFailure(init?.method ?? "GET", path, res.status, body);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return parser ? parser.parse(data) : data as T;
}

const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

function timeoutSignal(parent?: AbortSignal): AbortSignal {
  // AbortSignal.timeout is widely supported (Chrome 103+/Safari 16+/Electron
  // recent), but we still combine with caller's signal if provided.
  const own = AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS);
  if (!parent) return own;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([own, parent]);
  return own;
}

export async function fetchExternalJSON<T>(
  url: string,
  init?: RequestInit,
  parser?: Parser<T>,
): Promise<T> {
  const headers = (init?.headers as Record<string, string>) ?? {};
  const externalRequest = window.hermesDesktop?.externalRequest;
  if (externalRequest) {
    const result = await externalRequest({
      path: url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (!result.ok) {
      reportRestFailure(init?.method ?? "GET", url, result.status, result.body);
      throw new Error(`HTTP ${result.status}: ${result.body}`);
    }
    const data = result.body ? JSON.parse(result.body) : null;
    return parser ? parser.parse(data) : data as T;
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: timeoutSignal(init?.signal ?? undefined) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      reportRestFailure(init?.method ?? "GET", url, 0, "request timed out");
      throw new Error(`Request to ${url} timed out after ${EXTERNAL_FETCH_TIMEOUT_MS / 1000}s`);
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    reportRestFailure(init?.method ?? "GET", url, 0, error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (!res.ok) {
    const body = await res.text();
    reportRestFailure(init?.method ?? "GET", url, res.status, body);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  return parser ? parser.parse(data) : data as T;
}

/**
 * Fetch an external URL and return its raw response body as text (no JSON
 * parsing). Routes through the Rust `external_request` proxy when available
 * (avoids webview CSP / CORS), otherwise a plain fetch. Used for lightweight
 * metadata scrapes like reading a page's <title>.
 */
export async function fetchExternalText(url: string, init?: RequestInit): Promise<string> {
  const headers = (init?.headers as Record<string, string>) ?? {};
  const externalRequest = window.hermesDesktop?.externalRequest;
  if (externalRequest) {
    const result = await externalRequest({
      path: url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.body}`);
    return result.body ?? "";
  }
  const res = await fetch(url, { ...init, headers, signal: timeoutSignal(init?.signal ?? undefined) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function filenameFromUrl(url: string, mimeType?: string): string {
  const extFromMime = mimeType?.toLowerCase().includes("png")
    ? "png"
    : mimeType?.toLowerCase().includes("jpeg") || mimeType?.toLowerCase().includes("jpg")
      ? "jpg"
      : mimeType?.toLowerCase().includes("gif")
        ? "gif"
        : mimeType?.toLowerCase().includes("webp")
          ? "webp"
          : "png";
  try {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    if (last && /\.[a-z0-9]{2,8}$/i.test(last)) return last;
  } catch {
    // Fall through to timestamped filename.
  }
  return `external-image-${Date.now()}.${extFromMime}`;
}

export async function downloadExternalImageFile(url: string): Promise<File> {
  const input: DownloadExternalImageInput = { url };
  const nativeDownload = window.hermesDesktop?.downloadExternalImage;
  if (nativeDownload) {
    const result: DownloadedImageResult = await nativeDownload(input);
    const data = base64ToArrayBuffer(result.dataBase64);
    return new File([data], result.filename, { type: result.mimeType });
  }

  const res = await fetch(url, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.3" },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("URL 返回的不是图片内容");
  }
  return new File([blob], filenameFromUrl(url, blob.type), { type: blob.type });
}

export async function putJSON<T>(path: string, body: unknown, parser?: Parser<T>): Promise<T> {
  return fetchJSON<T>(path, { method: "PUT", body: JSON.stringify(body) }, parser);
}

export async function postJSON<T>(path: string, body: unknown, parser?: Parser<T>): Promise<T> {
  return fetchJSON<T>(path, { method: "POST", body: JSON.stringify(body) }, parser);
}

export async function patchJSON<T>(path: string, body: unknown, parser?: Parser<T>): Promise<T> {
  return fetchJSON<T>(path, { method: "PATCH", body: JSON.stringify(body) }, parser);
}

export async function deleteJSON<T>(path: string, body?: unknown, parser?: Parser<T>): Promise<T> {
  return fetchJSON<T>(path, {
    method: "DELETE",
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }, parser);
}

export function uploadAttachmentFile(
  sessionId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<AttachmentUploadResult> {
  const uploadFile = window.hermesDesktop?.uploadFile;
  if (uploadFile) {
    return file.arrayBuffer().then(async (data) => {
      onProgress?.(0);
      const result = await uploadFile({
        sessionId,
        name: file.name,
        type: file.type || undefined,
        data,
      });
      if (!result.ok) {
        throw new Error(`HTTP ${result.status}: ${result.body}`);
      }
      onProgress?.(100);
      return AttachmentUploadResult.parse(JSON.parse(result.body));
    });
  }

  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", runtime.getApiUrl("/api/upload"));
    const headers = authOnlyHeaders();
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Attachment upload failed"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
        return;
      }
      try {
        resolve(AttachmentUploadResult.parse(JSON.parse(xhr.responseText)));
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(form);
  });
}

/** True when attached to a remote gateway (a different machine's filesystem). */
export function isRemoteConnection(): boolean {
  return runtime.isRemote();
}

function attachmentParentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

function attachmentFileName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// Read a local image file's bytes (base64) via the desktop bridge, for attaching
// to a REMOTE gateway that can't see this machine's filesystem. Mirrors the
// official desktop's readImageForRemoteAttach. The desktop's read_workspace_file
// command confines reads to a root, so we pass the image's own directory; it
// caps inline images at 8 MB and returns null above that. Returns null when the
// bridge is unavailable or the file can't be read as an image.
export async function readImageBytesFromPath(
  path: string,
): Promise<{ contentBase64: string; filename: string } | null> {
  const read = window.hermesDesktop?.readWorkspaceFile;
  if (!read) return null;
  try {
    const preview = await read({ path, root: attachmentParentDir(path) });
    const dataUrl = preview?.dataUrl;
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(",");
    const contentBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return contentBase64
      ? { contentBase64, filename: attachmentFileName(path) }
      : null;
  } catch {
    return null;
  }
}
