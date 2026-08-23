import type { SqlAdapter } from "./sql";
import {
  createEmptyMemorySqlAdapterState,
  MemorySqlAdapter,
  type MemorySqlAdapterState,
} from "./sql";
import type { SessionRow, MessageRow } from "./types";

/**
 * SQL adapter for standalone (no-backend) mode: keeps the schema-v25 subset in
 * memory (via the existing MemorySqlAdapter used by unit tests) and snapshots
 * sessions + messages to localStorage after every write, so history survives
 * page reloads inside the plain-browser dev flow (run.py).
 */
export function createLocalPersistentSqlAdapter(key: string): SqlAdapter {
  const saveKey = `hermes.local-sql.${key}`;
  let state: MemorySqlAdapterState;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(saveKey) : null;
    state = raw ? deserializeState(JSON.parse(raw)) : createEmptyMemorySqlAdapterState();
  } catch {
    state = createEmptyMemorySqlAdapterState();
  }
  const memory = new MemorySqlAdapter(state);

  function persist(): void {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(saveKey, JSON.stringify(serializeState(memory.getState())));
    } catch {
      // Quota exceeded / storage disabled — persistence is best-effort.
    }
  }

  return {
    query(sql, params) {
      return memory.query(sql, params);
    },
    async exec(sql, params) {
      const affected = await memory.exec(sql, params);
      persist();
      return affected;
    },
  };
}

/**
 * JSON.parse turns Map objects into plain `{}` objects (Map is not in the
 * JSON spec). When the persisted state is restored, `state.sessions` and
 * `state.stateMeta` would be plain objects instead of Maps — calling
 * `.set()` on them throws "sessions.set is not a function". This helper
 * converts the deserialized plain objects back into proper Map instances.
 */
function deserializeState(raw: unknown): MemorySqlAdapterState {
  if (!raw || typeof raw !== "object") return createEmptyMemorySqlAdapterState();
  const obj = raw as Record<string, unknown>;
  return {
    sessions: toMap(obj.sessions) as Map<string, SessionRow>,
    messages: Array.isArray(obj.messages) ? obj.messages as MessageRow[] : [],
    stateMeta: toMap(obj.stateMeta) as Map<string, string>,
    nextMessageId: typeof obj.nextMessageId === "number" ? obj.nextMessageId : 1,
  };
}

function toMap(value: unknown): Map<unknown, unknown> {
  if (value instanceof Map) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return new Map(Object.entries(value));
  }
  return new Map();
}

/**
 * Convert Map instances to plain objects for JSON.stringify. Maps are not
 * serializable by JSON.stringify (they become `{}`), so we convert them to
 * plain objects before persisting. This round-trips cleanly with
 * `deserializeState` on reload.
 */
function serializeState(state: MemorySqlAdapterState): Record<string, unknown> {
  return {
    sessions: Object.fromEntries(state.sessions),
    messages: state.messages,
    stateMeta: Object.fromEntries(state.stateMeta),
    nextMessageId: state.nextMessageId,
  };
}