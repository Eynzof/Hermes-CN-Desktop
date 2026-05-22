import type { HermesMessageMetadata } from "@hermes/protocol";

export interface UiStoreSnapshot {
  kv: Record<string, unknown>;
}

export interface UiTurnStats {
  id: string;
  sessionId: string;
  gatewaySessionId?: string;
  clientMessageId?: string;
  backendMessageId?: number;
  turnIndex?: number;
  contentHash?: string;
  metadata?: HermesMessageMetadata;
  model?: string;
  provider?: string;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  ttftMs?: number;
  durationMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  apiCalls?: number;
  costUsd?: number;
  costStatus?: string;
  finishReason?: string;
  status?: string;
  createdAt?: number;
}

export interface UiEventInput {
  id: string;
  ts: number;
  eventName: string;
  sessionId?: string;
  source?: string;
  props?: Record<string, unknown>;
  appVersion?: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let kvCache: Record<string, unknown> = {};
let initialized = false;
let initPromise: Promise<void> | null = null;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.hermesDesktop;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export async function initUiStore(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const snapshot = await bridge()?.uiStoreSnapshot?.();
      kvCache = snapshot?.kv ?? {};
    } catch {
      kvCache = {};
    } finally {
      initialized = true;
      installGlobalUiStoreBridge();
      notify();
    }
  })();
  return initPromise;
}

export async function reloadUiStore(): Promise<void> {
  initPromise = null;
  initialized = false;
  await initUiStore();
}

export function readUiValue<T>(key: string, fallback: T): T {
  const value = kvCache[key];
  return value === undefined ? fallback : clone(value as T);
}

export function writeUiValue(key: string, value: unknown): void {
  kvCache[key] = clone(value);
  notify();
  void bridge()?.uiStoreSetKv?.({ key, value }).catch(() => {});
}

export function removeUiValue(key: string): void {
  delete kvCache[key];
  notify();
  void bridge()?.uiStoreRemoveKv?.({ key }).catch(() => {});
}

export function subscribeUiStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function __resetUiStoreForTests(seed: Record<string, unknown> = {}): void {
  kvCache = clone(seed);
  initialized = true;
  initPromise = null;
  installGlobalUiStoreBridge();
  notify();
}

export async function recordUiTurnStats(stats: UiTurnStats): Promise<void> {
  await bridge()?.uiStoreRecordTurnStats?.(stats).catch(() => {});
}

export async function getUiTurnStats(sessionId: string | undefined): Promise<UiTurnStats[]> {
  if (!sessionId) return [];
  try {
    return await bridge()?.uiStoreGetTurnStats?.({ sessionId }) ?? [];
  } catch {
    return [];
  }
}

export function recordUiEvent(
  input: Omit<UiEventInput, "id" | "ts"> & Partial<Pick<UiEventInput, "id" | "ts">>,
): void {
  const event: UiEventInput = {
    id: input.id ?? `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: input.ts ?? Date.now(),
    eventName: input.eventName,
    sessionId: input.sessionId,
    source: input.source,
    props: input.props,
    appVersion: input.appVersion,
  };
  void bridge()?.uiStoreRecordEvent?.(event).catch(() => {});
}

export function stableTextHash(value: string | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, "").trim();
  if (!text) return undefined;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function installGlobalUiStoreBridge(): void {
  (globalThis as any).__HERMES_UI_STORE__ = {
    get: readUiValue,
    set: writeUiValue,
    remove: removeUiValue,
    subscribe: subscribeUiStore,
  };
}

installGlobalUiStoreBridge();
