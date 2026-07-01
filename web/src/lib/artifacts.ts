import {
  MessagesResponse,
  SessionsResponse,
  type SessionMessage,
  type SessionSummary,
} from "@hermes/protocol";
import { fetchJSON } from "@/lib/transport";

export type ArtifactKind = "image" | "file" | "link";

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  value: string;
  label: string;
  sessionId: string;
  sessionTitle: string;
  profile?: string;
  role?: string;
  timestamp?: number;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]}]+/gi;
const PATH_RE = /(?:[A-Za-z]:\\[^\s<>"|?*]+|\/(?:Users|home|tmp|var|mnt|workspace|[\w.-]+)\/[^\s<>"')\]}]+)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i;

function titleOf(session: SessionSummary): string {
  return session.title?.trim() || session.preview?.trim() || session.id;
}

function labelOf(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname + url.pathname;
  } catch {
    const parts = value.split(/[\\/]/);
    return parts.at(-1) || value;
  }
}

function asImageValue(image: unknown): string | null {
  if (typeof image === "string") return image;
  if (!image || typeof image !== "object") return null;
  const obj = image as Record<string, unknown>;
  for (const key of ["url", "src", "path", "data", "dataUri", "data_url"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pushUnique(out: ArtifactRecord[], seen: Set<string>, item: ArtifactRecord) {
  const key = `${item.kind}:${item.value}:${item.sessionId}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(item);
}

function isUrlPathFragment(text: string, index: number | undefined): boolean {
  if (index === undefined || index <= 0) return false;
  return text[index - 1] === ":" || (text[index - 2] === ":" && text[index - 1] === "/");
}

export function collectArtifactsForSession(
  session: SessionSummary,
  messages: readonly SessionMessage[],
): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  const seen = new Set<string>();
  const sessionTitle = titleOf(session);
  const profile = session.profile;

  for (const message of messages) {
    const base = {
      sessionId: session.id,
      sessionTitle,
      profile,
      role: message.role,
      timestamp: message.timestamp,
    };

    for (const image of message.images ?? []) {
      const value = asImageValue(image);
      if (!value) continue;
      pushUnique(out, seen, {
        ...base,
        id: `${session.id}:${message.id}:image:${out.length}`,
        kind: "image",
        value,
        label: labelOf(value),
      });
    }

    const text = message.content ?? "";
    for (const match of text.matchAll(URL_RE)) {
      const value = match[0];
      pushUnique(out, seen, {
        ...base,
        id: `${session.id}:${message.id}:link:${out.length}`,
        kind: IMAGE_EXT_RE.test(value) ? "image" : "link",
        value,
        label: labelOf(value),
      });
    }

    for (const match of text.matchAll(PATH_RE)) {
      if (isUrlPathFragment(text, match.index)) continue;
      const value = match[0];
      pushUnique(out, seen, {
        ...base,
        id: `${session.id}:${message.id}:file:${out.length}`,
        kind: IMAGE_EXT_RE.test(value) ? "image" : "file",
        value,
        label: labelOf(value),
      });
    }
  }

  return out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function fetchRecentArtifacts(signal?: AbortSignal): Promise<ArtifactRecord[]> {
  const sessions = await fetchJSON(
    "/api/profiles/sessions?limit=30&min_messages=1&order=recent",
    { signal },
    SessionsResponse,
  );
  const chunks = await Promise.all(
    sessions.sessions.map(async (session) => {
      const params = session.profile ? `?profile=${encodeURIComponent(session.profile)}` : "";
      try {
        const messages = await fetchJSON(
          `/api/sessions/${encodeURIComponent(session.id)}/messages${params}`,
          { signal },
          MessagesResponse,
        );
        return collectArtifactsForSession(session, messages.messages);
      } catch {
        return [];
      }
    }),
  );
  return chunks.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}
