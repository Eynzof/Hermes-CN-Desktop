import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

const STORAGE_KEY_PREFIX = "hermes-cn-ui.composerDraft";

export type ComposerDraftTarget =
  | { kind: "new"; profile?: string | null }
  | { kind: "session"; sessionId?: string | null; profile?: string | null };

function cleanPart(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  return encodeURIComponent(text || fallback);
}

function runtimeScopeParts(): string[] {
  const runtime = typeof window !== "undefined" ? window.__HERMES_RUNTIME__ : undefined;
  const mode = runtime?.connectionMode ?? "managed";
  const baseUrl = runtime?.dashboardApiBaseUrl ?? runtime?.apiBaseUrl ?? "relative";
  return [cleanPart(mode, "managed"), cleanPart(baseUrl, "relative")];
}

export function composerDraftStorageKey(target: ComposerDraftTarget | null | undefined): string | null {
  if (!target) return null;
  const profile = cleanPart(target.profile, "default");
  const [mode, baseUrl] = runtimeScopeParts();
  if (target.kind === "new") {
    return [STORAGE_KEY_PREFIX, mode, baseUrl, profile, "new"].join(":");
  }

  const sessionId = (target.sessionId ?? "").trim();
  if (!sessionId) return null;
  return [
    STORAGE_KEY_PREFIX,
    mode,
    baseUrl,
    profile,
    "session",
    encodeURIComponent(sessionId),
  ].join(":");
}

export function readComposerDraftByKey(key: string | null | undefined): string {
  if (!key) return "";
  const value = readUiValue<unknown>(key, "");
  return typeof value === "string" ? value : "";
}

export function writeComposerDraftByKey(key: string | null | undefined, text: string): void {
  if (!key) return;
  if (!text.trim()) {
    removeUiValue(key);
    return;
  }
  writeUiValue(key, text);
}

export function forgetComposerDraftByKey(key: string | null | undefined): void {
  if (!key) return;
  removeUiValue(key);
}

export function readComposerDraft(target: ComposerDraftTarget | null | undefined): string {
  return readComposerDraftByKey(composerDraftStorageKey(target));
}

export function writeComposerDraft(target: ComposerDraftTarget | null | undefined, text: string): void {
  writeComposerDraftByKey(composerDraftStorageKey(target), text);
}
