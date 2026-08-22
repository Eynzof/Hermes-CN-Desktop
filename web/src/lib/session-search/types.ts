import type {
  SessionSearchResult as SearchResult,
  SearchRow,
  SessionSearchToolMessage,
} from "@hermes/protocol";

export type { SearchRow };

/** Internal routing decision produced by router.ts. */
export interface SearchRoute {
  strategy: "unicode61" | "cjk_bigram" | "trigram" | "like";
  /** Bigrammed query if the CJK path is selected. */
  bigrammedQuery?: string;
  /** Sanitized FTS5 MATCH query if applicable. */
  ftsQuery?: string;
  /** LIKE boolean pattern if the fallback path is selected. */
  likeQuery?: string;
  /** Why this path was chosen (TS equivalent of _describe_search_path). */
  description: string;
}

export interface SearchMessagesOptions {
  query: string;
  sourceFilter?: string[];
  excludeSources?: string[];
  roleFilter?: string;
  limit?: number;
  offset?: number;
  sort?: "rank" | "newest" | "oldest";
  includeInactive?: boolean;
  /** If true, also return surrounding +/-1 message rows for context. */
  withContext?: boolean;
}

export interface SearchMessagesResult {
  rows: SearchRow[];
  route: SearchRoute;
  /** Total rows returned before lineage dedup. */
  totalRaw: number;
}

export interface ProcessedSearchResult extends SearchResult {
  /** Message id from the messages table, when known. */
  messageId?: number;
  /** +/-1 message context. */
  context?: SessionSearchToolMessage[];
}

/** Pluggable backend used by SessionSearchEngine (Rust IPC or REST fallback). */
export interface SessionSearchBackend {
  ftsSearch(request: { sql: string; params: (string | number | null)[] }): Promise<SearchRow[]>;
  query(request: { sql: string; params: (string | number | null)[] }): Promise<unknown[]>;
  exec?(request: { sql: string; params: (string | number | null)[] }): Promise<number>;
  searchMeta?(): Promise<{ row_count_messages: number; row_count_sessions: number }>;
}

/** Build a backend that invokes the Rust state_db Tauri commands via window.hermesDesktop. */
export function createTauriStateDbBackend(): SessionSearchBackend {
  const bridge = (typeof window !== "undefined" ? window.hermesDesktop : undefined) as
    | { stateDb?: { query: Function; exec: Function; ftsSearch: Function; searchMeta: Function } }
    | undefined;
  if (!bridge?.stateDb) {
    throw new Error("hermesDesktop.stateDb is not available");
  }
  return {
    async ftsSearch(request) {
      const rows = await bridge.stateDb!.ftsSearch(request);
      return rows as SearchRow[];
    },
    async query(request) {
      return bridge.stateDb!.query(request) as Promise<unknown[]>;
    },
    async exec(request) {
      return bridge.stateDb!.exec(request) as Promise<number>;
    },
    async searchMeta() {
      const meta = await bridge.stateDb!.searchMeta();
      return meta as { row_count_messages: number; row_count_sessions: number };
    },
  };
}
