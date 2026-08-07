// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/types.ts — the MemOS (WanderMemory) API contract, ported from
// WanderMemory `web/app/src/api/types.ts` + `fs_types.ts` (docs/memory_api.md
// §3–§4). Field comments cite the doc section so drift between doc and client
// is caught in review. TypeScript-only — no Zod (Hermes protocol schemas stay
// in packages/protocol; this module is deliberately schema-free to match the
// source contract).
// ─────────────────────────────────────────────────────────────────────────────

/** §3.1 serialize_item — TextualMemoryItem → JSON-safe dict */
export interface MemoryItem {
  id: string;
  memory: string;
  metadata: Record<string, unknown>; // may carry updated_at etc.
}

/** §4.1 collision summary — ALWAYS present on write responses */
export interface CollisionSummary {
  deleted: number;
  merged: number;
  stored_new: boolean;
  reason: string;
}

/** §4.1 GET /v1/health */
export interface HealthResponse {
  status: 'ok';
  backends: Record<string, boolean>; // {} in remote mode / probe failure
  model: string;
  backend?: string; // remote mode only: client_type
}

/** §4.1 GET /v1/backends */
export interface BackendsResponse {
  devices: Array<{ backend: string; index: number; name: string; total_mib: number }>;
  remote?: boolean; // true in remote mode (devices: [])
}

/** §4.1 GET /v1/models */
export interface ModelsResponse {
  model: string;
  reasoning: string;
}

/** §4.1 error convention */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** §4.1 write/read response envelopes */
export interface AddMemoryResponse {
  memory: MemoryItem;
  collision: CollisionSummary;
}

export interface AddDialogueResponse {
  stored: MemoryItem[];
  collisions: CollisionSummary[]; // index-aligned with stored[]
  total: number;
}

export interface SearchResponse {
  results: MemoryItem[];
}

export interface GetMemoryResponse {
  memory: MemoryItem;
}

export interface ContextResponse {
  context: string;
}

export interface ChatResponse {
  reply: string;
  /** Keyword trace (additive — optional so an old server never breaks the UI):
   *  the merged chat step's generated search keywords (present every turn;
   *  empty only when the keyword parse failed), plus the memories the reply
   *  was grounded on. */
  dreamed_keywords?: string[];
  grounded_memories?: MemoryItem[];
}

export interface MaintenanceResponse {
  total: number;
  errors: string[];
}

// ── §4.2 WS frames ──────────────────────────────────────────────────────────

export interface WsRequest {
  id: number;
  op: string;
  payload: Record<string, unknown>;
}

export interface WsResultFrame {
  id: number | null;
  ok: true;
  result: unknown;
}

export interface WsDeltaFrame {
  id: number;
  ok: true;
  type: 'delta';
  delta: string;
}

export interface WsDoneFrame {
  id: number;
  ok: true;
  type: 'done';
  result: ChatResponse;
}

export interface WsErrorFrame {
  id: number | null;
  ok: false;
  error: { code: string; message: string };
}

export interface WsPongFrame {
  id: null;
  type: 'pong';
  ts: number;
}

export type WsFrame = WsResultFrame | WsDeltaFrame | WsDoneFrame | WsErrorFrame | WsPongFrame;

/** §4.2 op vocabulary */
export const WS_OPS = [
  'dialogues.add',
  'memories.add',
  'memories.search',
  'memories.get',
  'memories.delete',
  'memories.list',
  'context.build',
  'chat',
  'maintenance.run',
  'backends.list',
  'health',
  'models',
] as const;

export type WsOp = (typeof WS_OPS)[number];

// ── file-system service contract (mem_filesys) ──────────────────────────────

export interface ScannedFile {
  rel_path: string;
  category: string;
  size: number;
}

export interface ScanResponse {
  root: string;
  files: ScannedFile[];
  ignored_count: number;
  binary_count: number;
  errors: string[][];
}

export interface UpdateIngestRequest {
  directory: string;
  rel_path: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateIngestResponse {
  root: string;
  rel_path: string;
  stored: boolean;
  memory: MemoryItem;
  collision: CollisionSummary;
  errors: string[];
}
