import type { ExportSessionJsonResult } from "@hermes/protocol";
import { fetchJSON } from "@/lib/transport";

export interface SessionExportOutcome extends ExportSessionJsonResult {
  fileName: string;
}

function sessionExportPath(sessionId: string, profile?: string | null): string {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/export`;
  const cleanProfile = profile?.trim();
  return cleanProfile ? `${path}?profile=${encodeURIComponent(cleanProfile)}` : path;
}

export function sessionExportFileName(sessionId: string): string {
  const safeId = sessionId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "export";
  return `session-${safeId}.json`;
}

function downloadJsonInBrowser(fileName: string, content: string): number {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return blob.size;
}

export async function exportSessionJson(
  sessionId: string,
  profile?: string | null,
): Promise<SessionExportOutcome> {
  const data = await fetchJSON<unknown>(sessionExportPath(sessionId, profile));
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const fileName = sessionExportFileName(sessionId);
  const nativeExport = window.hermesDesktop?.exportSessionJson;

  if (nativeExport) {
    const result = await nativeExport({ fileName, content });
    if (!result.ok && !result.canceled) {
      throw new Error(result.error || "无法写入会话导出文件");
    }
    return { ...result, fileName };
  }

  return {
    ok: true,
    canceled: false,
    bytes: downloadJsonInBrowser(fileName, content),
    fileName,
  };
}
