// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/index.ts — public API of the MemOS (WanderMemory) client
// abstraction layer. Everything a view needs lives behind this entry point.
// ─────────────────────────────────────────────────────────────────────────────

// types — the §4.1/§4.2 API contract + FS contract
export type {
  MemoryItem,
  CollisionSummary,
  HealthResponse,
  BackendsResponse,
  ModelsResponse,
  ApiErrorBody,
  AddMemoryResponse,
  AddDialogueResponse,
  SearchResponse,
  GetMemoryResponse,
  ContextResponse,
  ChatResponse,
  MaintenanceResponse,
  WsRequest,
  WsResultFrame,
  WsDeltaFrame,
  WsDoneFrame,
  WsErrorFrame,
  WsPongFrame,
  WsFrame,
  WsOp,
  ScannedFile,
  ScanResponse,
  UpdateIngestRequest,
  UpdateIngestResponse,
} from './types';
export { WS_OPS } from './types';

// errors — ApiError + treatment table + coercion
export {
  ApiError,
  treatmentFor,
  toApiError,
  COLLISION_ERROR_CODES,
} from './errors';
export type { ErrorTreatment } from './errors';

// endpoints — origin resolution (env → ui-store → discovery → defaults)
export {
  resolveEndpoints,
  resolveEndpointsAsync,
  discoverEndpoints,
  saveEndpoints,
  DEFAULT_API_ORIGIN,
  DEFAULT_WS_URL,
  DEFAULT_FS_ORIGIN,
  UI_KEY_API_ORIGIN,
  UI_KEY_WS_URL,
  UI_KEY_FS_ORIGIN,
  UI_KEY_DISCOVERED,
  PROBE_PORTS_START,
  PROBE_PORTS_END,
  PROBE_TIMEOUT_MS,
} from './endpoints';
export type { WanderMemoryEndpoints, WanderMemoryPortsFile, EndpointDeps } from './endpoints';

// client — the unified interface + live client + singleton
export {
  MemOsLiveClient,
  createMemOsClient,
  getWanderMemoryClient,
  getWanderMemoryClientAsync,
  resetWanderMemoryClient,
  disposeWanderMemoryClient,
} from './client';
export type { WanderMemoryClient } from './client';

// rest — transport-backed REST client + error adaptation
export { MemOsRestClient, adaptTransportError, resolveRequestUrl, isAbsoluteRequestUrl } from './rest';

// ws — the §4.2 frame protocol client
export { MemOsWsClient } from './ws';
export type { ConnectionState } from './ws';

// fs-client — file-system scan/ingest client
export { MemOsFileSystemClient } from './fs-client';
export type { FileSystemClient } from './fs-client';

// demo — offline simulation
export { DemoWanderMemoryClient } from './demo';
