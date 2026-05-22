import { readUiValue, writeUiValue } from "@/lib/ui-store";

const STORAGE_KEY = "hermes:gateway-session-map";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

interface SessionEntry {
  persistentId: string;
  ts: number;
}

type SessionMap = Record<string, SessionEntry>;

function readMap(): SessionMap {
  const parsed = readUiValue<unknown>(STORAGE_KEY, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  if (typeof Object.values(parsed)[0] === "string") {
    const migrated: SessionMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        migrated[key] = { persistentId: value, ts: Date.now() };
      }
    }
    writeMap(migrated);
    return migrated;
  }

  const clean: SessionMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.persistentId !== "string" || !entry.persistentId) continue;
    if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)) continue;
    clean[key] = { persistentId: entry.persistentId, ts: entry.ts };
  }
  return clean;
}

function writeMap(map: SessionMap) {
  writeUiValue(STORAGE_KEY, map);
}

function pruneExpired(map: SessionMap): SessionMap {
  const now = Date.now();
  const entries = Object.entries(map).filter(
    ([, entry]) => now - entry.ts < MAX_AGE_MS,
  );

  if (entries.length <= MAX_ENTRIES) {
    return Object.fromEntries(entries);
  }

  entries.sort((a, b) => b[1].ts - a[1].ts);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function rememberSessionMapping(gatewaySessionId: string, persistentSessionId: string) {
  if (!gatewaySessionId || !persistentSessionId) return;
  if (gatewaySessionId === persistentSessionId) return;
  const map = pruneExpired(readMap());
  map[gatewaySessionId] = { persistentId: persistentSessionId, ts: Date.now() };
  writeMap(map);
}

export function resolvePersistentSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const entry = readMap()[sessionId];
  if (!entry) return sessionId;
  if (Date.now() - entry.ts > MAX_AGE_MS) return sessionId;
  return entry.persistentId;
}

export function resolveGatewaySessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const map = readMap();
  const now = Date.now();
  for (const [gatewayId, entry] of Object.entries(map)) {
    if (entry.persistentId === sessionId && now - entry.ts < MAX_AGE_MS) {
      return gatewayId;
    }
  }
  return undefined;
}
