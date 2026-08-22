/**
 * Hermes Agent Tools — in-process TypeScript tool registry + toolset resolver.
 *
 * Mirrors the Python `tools/registry.py` + `toolsets.py` surface used by the
 * CN Core runtime so the desktop agent loop can run without a WebSocket link
 * to the managed Python runtime.
 */

// Core data types
export * from "./types.js";

// Registry, catalog, resolution
export * from "./registry.js";
export * from "./toolsets.js";
export * from "./catalog.js";
export * from "./categories.js";
export * from "./dispatch.js";

// Capability / workflow gates
export * from "./gates.js";

// Platform config parity
export * from "./platform-config.js";
export * from "./platform-toolsets.js";

// Spotify tools + client (explicit re-exports to avoid type ambiguity with test files)
export {
  SpotifyClient,
  SpotifyAuthManager,
  SpotifyAuthRequiredError,
  SpotifyApiError,
  SpotifyError,
  registerSpotifyTools,
  setCredentialProvider,
  getCredentialProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  quarantineTokenState,
  tokenResponseToState,
  normalizeSpotifyUri,
  normalizeSpotifyId,
  normalizeSpotifyUris,
  friendlySpotifyErrorMessage,
  DEFAULT_SPOTIFY_SCOPE,
  type SpotifyCredentialProvider,
  type SpotifyAuthConfig,
  type SpotifyToolContext,
  type FetchLike,
} from "./spotify/index.js";

// Home Assistant tools + client
export {
  HassClient,
  isValidEntityId,
  isValidServiceName,
  isBlockedDomain,
  parseStringData,
  filterAndSummarize,
  buildServicePayload,
  parseServiceResponse,
  summarizeServices,
  haListEntities,
  haGetState,
  haListServices,
  haCallService,
  registerHomeAssistantTools,
  type HassState,
  type HassEntitiesSummary,
  type HassServicesSummary,
  type HassServiceResult,
  type HaInvoker,
  type HassClientOptions,
} from "./homeassistant/index.js";

// Google Meet bundled plugin
export * from "./meet/index.js";

// Token estimation
export * from "./token-estimate.js";

// Dynamic toolsets (MCP, plugins, custom)
export type {
  DynamicToolsetDef,
  DynamicToolEntry,
  McpServerEntry,
  PluginEntry,
  RegistrationSnapshot,
} from "./dynamic-toolsets/index.js";
export {
  ToolRegistry as DynamicToolRegistry,
  ToolsetRegistry as DynamicToolsetRegistry,
  StubMcpConnectionManager,
  sanitizeMcpToolName,
  mcpToolName,
  loadCustomToolsets,
  customToolsetToDefinition,
  expandWildcard,
  isWildcard,
} from "./dynamic-toolsets/index.js";

// Unified definition builder used by the in-process agent loop.
export { getToolDefinitions } from "./model-tools.js";
