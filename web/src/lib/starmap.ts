import { StarmapGraph, type StarmapGraph as StarmapGraphT } from "@hermes/protocol";
import { deleteJSON, fetchJSON, putJSON } from "@/lib/transport";

function profileParam(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

export function fetchStarmapGraph(profile?: string, signal?: AbortSignal): Promise<StarmapGraphT> {
  return fetchJSON(`/api/learning/graph${profileParam(profile)}`, { signal }, StarmapGraph);
}

export function fetchStarmapNode(id: string, profile?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ id });
  if (profile) params.set("profile", profile);
  return fetchJSON(`/api/learning/node?${params.toString()}`, { signal });
}

export function updateStarmapNode(id: string, content: string, profile?: string) {
  return putJSON("/api/learning/node", { id, content, profile });
}

export function deleteStarmapNode(id: string, profile?: string) {
  return deleteJSON("/api/learning/node", { id, profile });
}

export function encodeStarmapShareCode(graph: StarmapGraphT): string {
  const json = JSON.stringify(graph);
  const bytes = new TextEncoder().encode(json);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeStarmapShareCode(code: string): StarmapGraphT {
  const clean = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  return StarmapGraph.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
