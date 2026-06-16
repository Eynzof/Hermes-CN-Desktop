import { useEffect, useState } from "react";
import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";
import type { ComposerModelSelection } from "@/components/chat/composer-types";

const STORAGE_KEY_PREFIX = "hermes:last-used-model";
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const subscribers = new Set<() => void>();

function notifyLastUsedModelChanged() {
  subscribers.forEach((fn) => fn());
}

interface StoredEntry {
  selection: ComposerModelSelection;
  ts: number;
}

function isValidSelection(value: unknown): value is ComposerModelSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || !v.model) return false;
  if (v.provider !== undefined && typeof v.provider !== "string") return false;
  if (v.providerName !== undefined && typeof v.providerName !== "string") return false;
  if (v.contextWindow !== undefined && typeof v.contextWindow !== "number") return false;
  return true;
}

function safeScopePart(value: string | undefined | null, fallback: string): string {
  const normalized = (value ?? "").trim();
  return encodeURIComponent(normalized || fallback);
}

export function modelSelectionScopeKey(): string {
  const runtime = typeof window !== "undefined" ? window.__HERMES_RUNTIME__ : undefined;
  const mode = runtime?.connectionMode ?? "managed";
  const baseUrl = runtime?.apiBaseUrl || runtime?.dashboardApiBaseUrl || "relative";
  const profile = runtime?.currentProfile || "default";
  return [mode, baseUrl, profile].map((part) => safeScopePart(part, "default")).join(":");
}

function scopedStorageKey(): string {
  return `${STORAGE_KEY_PREFIX}:${modelSelectionScopeKey()}`;
}

function readEntry(key: string): ComposerModelSelection | null {
  const parsed = readUiValue<StoredEntry | null>(key, null);
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.ts !== "number") return null;
  if (Date.now() - parsed.ts > MAX_AGE_MS) return null;
  if (!isValidSelection(parsed.selection)) return null;
  return parsed.selection;
}

export function readLastUsedModel(): ComposerModelSelection | null {
  try {
    // Deliberately do not read the legacy global key. It was shared across the
    // old local/remote split and could make a managed K2.6 selection override a
    // newly attached CLI backend whose /api/model/info says gpt-5.5.
    return readEntry(scopedStorageKey());
  } catch {
    return null;
  }
}

export function rememberLastUsedModel(selection: ComposerModelSelection) {
  if (!isValidSelection(selection)) return;
  try {
    const entry: StoredEntry = { selection, ts: Date.now() };
    writeUiValue(scopedStorageKey(), entry);
    // Remove the obsolete global entry opportunistically so future readers in
    // older renderer windows do not keep resurrecting a cross-backend model.
    removeUiValue(LEGACY_STORAGE_KEY);
    notifyLastUsedModelChanged();
  } catch {}
}

export function forgetLastUsedModel() {
  try {
    removeUiValue(scopedStorageKey());
    notifyLastUsedModelChanged();
  } catch {}
}

// React hook — re-renders when last-used model changes in this renderer.
export function useLastUsedModel(): ComposerModelSelection | null {
  const [value, setValue] = useState<ComposerModelSelection | null>(() => readLastUsedModel());

  useEffect(() => {
    const refresh = () => setValue(readLastUsedModel());
    subscribers.add(refresh);
    const unsubscribe = subscribeUiStore(refresh);
    return () => {
      subscribers.delete(refresh);
      unsubscribe();
    };
  }, []);

  return value;
}
