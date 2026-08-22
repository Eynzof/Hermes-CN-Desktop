/**
 * Local-first dashboard API client.
 *
 * Branches between in-process Tauri commands (managed mode) and the remote
 * REST proxy (attached/remote mode) for the fork-only dashboard surface:
 *   /api/fs/list, /api/upload, /api/media, /api/mcp-servers,
 *   /api/profiles/active, /api/memory/providers/{name}/status,
 *   /api/providers/oauth.
 */
import { runtime } from "./runtime";
import { fetchJSON } from "./transport";
import {
  ActiveProfileResponse,
  AttachmentUploadResult,
  FsListResponse,
  MemoryProviderRuntimeStatusResponse,
  McpServersResponse,
  OAuthProvidersResponse,
} from "@hermes/protocol";

export interface LocalAttachmentInput {
  sessionId: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  const binary = Array.from(buffer, (b) => String.fromCharCode(b)).join("");
  return btoa(binary);
}

function isManagedDesktop(): boolean {
  return runtime.isManaged() && typeof window !== "undefined" && !!window.hermesDesktop;
}

export async function listFs(path: string): Promise<FsListResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.fsList) {
    return FsListResponse.parse(await window.hermesDesktop.fsList(path));
  }
  return fetchJSON<FsListResponse>(`/api/fs/list?path=${encodeURIComponent(path)}`, undefined, FsListResponse);
}

export async function uploadAttachment(input: LocalAttachmentInput): Promise<AttachmentUploadResult> {
  if (isManagedDesktop() && window.hermesDesktop?.uploadAttachmentLocal) {
    return AttachmentUploadResult.parse(
      await window.hermesDesktop.uploadAttachmentLocal({
        sessionId: input.sessionId,
        name: input.name,
        mimeType: input.mimeType,
        data: arrayBufferToBase64(input.data),
      }),
    );
  }
  const body = new FormData();
  body.append("file", new Blob([input.data as BlobPart], { type: input.mimeType }), input.name);
  body.append("session_id", input.sessionId);
  return fetchJSON<AttachmentUploadResult>("/api/upload", { method: "POST", body }, AttachmentUploadResult);
}

export async function getMcpSummary(): Promise<McpServersResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.getMcpSummary) {
    return McpServersResponse.parse(await window.hermesDesktop.getMcpSummary());
  }
  return fetchJSON<McpServersResponse>("/api/mcp-servers", undefined, McpServersResponse);
}

export async function getActiveProfile(): Promise<ActiveProfileResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.getActiveProfile) {
    return ActiveProfileResponse.parse(await window.hermesDesktop.getActiveProfile());
  }
  return fetchJSON<ActiveProfileResponse>("/api/profiles/active", undefined, ActiveProfileResponse);
}

export async function setActiveProfile(name: string): Promise<ActiveProfileResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.setActiveProfile) {
    return ActiveProfileResponse.parse(await window.hermesDesktop.setActiveProfile({ name }));
  }
  return fetchJSON<ActiveProfileResponse>(
    "/api/profiles/active",
    { method: "PUT", body: JSON.stringify({ name }) },
    ActiveProfileResponse,
  );
}

export async function getMemoryProviderStatus(name: string): Promise<MemoryProviderRuntimeStatusResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.getMemoryProviderStatus) {
    return MemoryProviderRuntimeStatusResponse.parse(await window.hermesDesktop.getMemoryProviderStatus(name));
  }
  return fetchJSON<MemoryProviderRuntimeStatusResponse>(
    `/api/memory/providers/${encodeURIComponent(name)}/status`,
    undefined,
    MemoryProviderRuntimeStatusResponse,
  );
}

export interface GetOAuthProvidersInput {
  refresh?: boolean;
}

export async function getOAuthProviders(input?: GetOAuthProvidersInput): Promise<OAuthProvidersResponse> {
  if (isManagedDesktop() && window.hermesDesktop?.getOAuthProviders) {
    return OAuthProvidersResponse.parse(await window.hermesDesktop.getOAuthProviders(input));
  }
  const qs = input?.refresh ? "?refresh=true" : "";
  return fetchJSON<OAuthProvidersResponse>(`/api/providers/oauth${qs}`, undefined, OAuthProvidersResponse);
}

export async function mediaDataUrl(path: string): Promise<string> {
  if (isManagedDesktop() && window.hermesDesktop?.mediaDataUrl) {
    const result = await window.hermesDesktop.mediaDataUrl(path);
    return result.dataUrl;
  }
  const result = await fetchJSON<{ data_url?: string }>(`/api/media?path=${encodeURIComponent(path)}`);
  return result.data_url ?? "";
}

export async function mediaFileUrl(path: string): Promise<string> {
  if (isManagedDesktop() && window.hermesDesktop?.mediaFileUrl) {
    const result = await window.hermesDesktop.mediaFileUrl(path);
    return result.url;
  }
  return `/api/media/file?path=${encodeURIComponent(path)}`;
}
