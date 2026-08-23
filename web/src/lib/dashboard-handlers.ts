/**
 * Local-first dashboard route handlers.
 *
 * These handlers replace the Python FastAPI routes one family at a time. Each
 * handler receives the same `{ path, method, body, headers }` context that the
 * remote proxy would have produced and must return the same JSON shape.
 *
 * For routes that need OS-level work (file reads, SQLite, process stats), the
 * handler calls Rust Tauri commands. For routes that are pure UI metadata, the
 * handler can read from the local UI store or return a static scaffold.
 */
import { readUiValue, writeUiValue } from "./ui-store";
import { registerDashboardHandler, createDashboardRouter, registerDashboardPrefixHandler, registerLocalOnlyHandler, registerLocalOnlyPrefixHandler, type DashboardRequestContext } from "./dashboard-router";
import { DESKTOP_VERSION, versionLabel } from "./build-info";
import {
  BasicAuthProvider,
  TokenAuthProvider,
  createInMemorySessionStore,
  createAuthRoutes,
  DashboardRouter,
} from "@hermes/dashboard";
import {
  listFs,
  uploadAttachment,
  mediaDataUrl,
  mediaFileUrl,
  getMcpSummary,
  getActiveProfile,
  setActiveProfile,
  getMemoryProviderStatus,
  getOAuthProviders,
  type LocalAttachmentInput,
} from "./dashboard-local";
import {
  ActiveProfileResponse,
  AnalyticsResponse,
  ConfigSchemaResponse,
  EnvVarsResponse,
  LogsResponse,
  MessagesResponse,
  ModelInfo,
  ModelOptionsResult,
  MoaConfigResponse,
  MutationOkResponse,
  ProfileSoulResponse,
  SearchResponse,
  SessionDetail,
  SessionsResponse,
  SkillsResponse,
} from "@hermes/protocol";
import { getLocalSessionStore } from "./session-store/local-store";
import { LOCAL_MODEL_CATALOG } from "./gateway-inprocess";

/** Local-first /api/status — returns a StatusResponse-shaped object so
 *  useStatus (which parses with StatusResponse) resolves successfully
 *  without a backend. The health grid uses `!!status` to decide whether
 *  Dashboard/Gateway is reachable; if this fails to parse, status is
 *  undefined and the grid shows "服务未响应".
 *
 *  gateway_running=false is correct: there is no PTY daemon in local mode.
 *  The health grid treats `!!status` (dashboard responded) as the real
 *  reachability signal, not gateway_running. */
const LOCAL_STATUS = {
  version: versionLabel(DESKTOP_VERSION) ?? "0.0.0",
  release_date: "",
  gateway_running: false,
  gateway_state: "",
  gateway_exit_reason: null,
  gateway_updated_at: null,
  active_sessions: 0,
  hermes_home: undefined,
  config_path: undefined,
  env_path: undefined,
};

// ── Local config store helpers ───────────────────────────────────────
// The UI store (web/src/lib/ui-store.ts) is the single source of truth for
// local-first config. It persists to Rust KV in Tauri mode and to
// localStorage in browser mode, so saved config survives reloads with no
// backend. The Python backend's PUT /api/config does a deep-merge of the
// patch into config.yaml; we replicate that in-memory.

const CONFIG_KEY = "hermes.active-config";
const ENV_VARS_KEY = "hermes.env-vars";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** Deep-merge `patch` into `base` (mutates neither). Arrays are replaced, not
 *  concatenated — same as the Python backend's `_denormalize_config_from_web`. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readLocalConfig(): Record<string, unknown> {
  return readUiValue<Record<string, unknown>>(CONFIG_KEY, {});
}

function writeLocalConfig(config: Record<string, unknown>): void {
  writeUiValue(CONFIG_KEY, config);
}

function readLocalEnvVars(): Record<string, string> {
  return readUiValue<Record<string, string>>(ENV_VARS_KEY, {});
}

function writeLocalEnvVars(vars: Record<string, string>): void {
  writeUiValue(ENV_VARS_KEY, vars);
}

export function dashboardStatusHandler() {
  return LOCAL_STATUS;
}

export function dashboardConfigHandler() {
  // Local-first config store. The Python backend returns the full config.yaml
  // object; we return the same shape from the UI store so hooks like
  // useConfig / useSaveConfig round-trip without a backend.
  return readLocalConfig();
}

/** Local PUT /api/config — deep-merge the patch into the stored config.
 *
 *  Mirrors the Python backend's PUT /api/config which writes the full config
 *  object. The settings page sends a partial patch (e.g. just
 *  { providers: { openai: {...} } }) and expects the backend to merge it.
 *  Without this handler the request fell through to fetch → Vite proxy →
 *  dead 9120 → ECONNREFUSED, surfacing as an HTTP 500 on 保存配置. */
export function dashboardConfigPutHandler(ctx: DashboardRequestContext) {
  const body = (ctx.body ?? {}) as { config?: Record<string, unknown> };
  const patch = isPlainObject(body.config) ? body.config : {};
  const next = deepMerge(readLocalConfig(), patch);
  writeLocalConfig(next);
  return MutationOkResponse.parse({ ok: true });
}

/** Local GET /api/env — return saved env vars as `EnvVarInfo` records.
 *
 *  The Core backend returns a flat `Record<string, EnvVarInfo>` (see
 *  `hermes_cli/web_server.py` `_get_env_vars_sync` — keys are env-var names,
 *  values are `{ is_set, redacted_value, description, url, category,
 *  is_password, tools, advanced, ... }`). `EnvVarsResponse =
 *  z.record(EnvVarInfo)` parses that flat dict directly, so the fallback must
 *  return a flat record, NOT `{ env: {} }` — wrapping it made Zod validate the
 *  string key `"env"` against `EnvVarInfo` and reject `{}` for missing every
 *  required field, surfacing "环境变量加载失败".
 *
 *  We store saved API keys in the UI store under `hermes.env-vars` and surface
 *  them here so the settings page shows the user's keys after a page reload. */
function localEnvHandler(): Record<string, unknown> {
  const vars = readLocalEnvVars();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    result[key] = {
      is_set: true,
      redacted_value: "••••••••",
      description: "",
      url: null,
      category: "custom",
      is_password: true,
      tools: [],
      advanced: false,
      custom: true,
      channel_managed: false,
    };
  }
  return result;
}

/** Local PUT /api/env — store a single env var (API key) in the UI store. */
function localEnvPutHandler(ctx: DashboardRequestContext) {
  const body = (ctx.body ?? {}) as { key?: string; value?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!key) {
    throw new Error("HTTP 400: key is required");
  }
  const vars = readLocalEnvVars();
  if (value) {
    vars[key] = value;
  } else {
    delete vars[key];
  }
  writeLocalEnvVars(vars);
  return MutationOkResponse.parse({ ok: true });
}

/** Local DELETE /api/env — remove a single env var from the UI store. */
function localEnvDeleteHandler(ctx: DashboardRequestContext) {
  const body = (ctx.body ?? {}) as { key?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key) {
    const vars = readLocalEnvVars();
    delete vars[key];
    writeLocalEnvVars(vars);
  }
  return MutationOkResponse.parse({ ok: true });
}

/** Local POST /api/env/reveal — return the stored value so the UI can show it.
 *
 *  In managed mode the backend gates this behind auth and redacts; in local
 *  mode the user is the only one who has access, so returning the value is
 *  safe. */
function localEnvRevealHandler(ctx: DashboardRequestContext) {
  const body = (ctx.body ?? {}) as { key?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const vars = readLocalEnvVars();
  return { value: vars[key] ?? "" };
}

export function dashboardWebhooksHandler() {
  return { webhooks: [] };
}

export function dashboardPairingHandler() {
  return { pairings: [] };
}

export function dashboardChannelsHandler() {
  return { channels: [] };
}

export function dashboardPluginsHandler() {
  return { plugins: [] };
}

export function dashboardThemesHandler() {
  return { themes: [] };
}

export async function dashboardFsListHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const rawPath = url.searchParams.get("path") ?? ".";
  return listFs(rawPath);
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function dashboardUploadHandler(ctx: DashboardRequestContext) {
  const body = (ctx.body ?? {}) as { session_id?: string; name?: string; mime_type?: string; data?: string };
  const input: LocalAttachmentInput = {
    sessionId: body.session_id ?? "default",
    name: body.name ?? "upload",
    mimeType: body.mime_type ?? "application/octet-stream",
    data: typeof body.data === "string" ? base64ToUint8Array(body.data) : new Uint8Array(0),
  };
  return uploadAttachment(input);
}

export async function dashboardMediaHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const rawPath = url.searchParams.get("path") ?? "";
  return { data_url: await mediaDataUrl(rawPath), ok: true };
}

export async function dashboardMediaFileHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const rawPath = url.searchParams.get("path") ?? "";
  return { url: await mediaFileUrl(rawPath) };
}

export async function dashboardMcpServersHandler() {
  return getMcpSummary();
}

export async function dashboardActiveProfileHandler(ctx: DashboardRequestContext) {
  if (ctx.method === "GET") {
    return getActiveProfile();
  }
  const name = typeof ctx.body === "object" && ctx.body !== null ? (ctx.body as { name?: string }).name : undefined;
  if (!name) return getActiveProfile();
  return setActiveProfile(name);
}

export async function dashboardMemoryProviderStatusHandler(ctx: DashboardRequestContext) {
  const match = ctx.path.match(/\/api\/memory\/providers\/([^/]+)\/status/);
  const name = match?.[1] ?? "";
  return getMemoryProviderStatus(decodeURIComponent(name));
}

export async function dashboardOAuthProvidersHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const refresh = url.searchParams.get("refresh") === "true";
  return getOAuthProviders({ refresh });
}

/** Register the baseline local-first handlers. Call once at app startup. */
const sessionsStore = getLocalSessionStore();

function parseLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

async function sessionsListHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const limit = parseLimit(url.searchParams.get("limit"), 50);
  const offset = parseLimit(url.searchParams.get("offset"), 0);
  const includeArchived = url.searchParams.get("include_archived") === "true";
  const result = await sessionsStore.list({ limit, offset, includeArchived });
  return SessionsResponse.parse(result);
}

async function sessionDetailHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const session = await sessionsStore.get(id);
  if (!session) throw new Error(`HTTP 404: session ${id} not found`);
  return SessionDetail.parse(session);
}

async function sessionMessagesHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const messages = await sessionsStore.getMessages(id);
  return MessagesResponse.parse({ session_id: id, messages });
}

async function deleteSessionHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  await sessionsStore.delete(id);
  return MutationOkResponse.parse({ ok: true });
}

async function archiveSessionHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const archived = url.pathname.endsWith("/archive") ? true : false;
  await sessionsStore.archive(id, archived);
  return MutationOkResponse.parse({ ok: true });
}

/** Prefix dispatcher for /api/sessions/<id>[/messages|/archive].
 *
 *  The router does exact + prefix matching but has no {id} path-parameter
 *  expansion, so /api/sessions/{id} never matches a real session id like
 *  /api/sessions/20260823_170325_ba3371. This handler parses the segments
 *  after /api/sessions/ and dispatches to the correct sub-handler:
 *
 *  GET   /api/sessions/<id>           → sessionDetailHandler
 *  GET   /api/sessions/<id>/messages   → sessionMessagesHandler
 *  POST  /api/sessions/<id>/archive    → archiveSessionHandler
 *  DELETE /api/sessions/<id>           → deleteSessionHandler
 *
 *  Exact routes /api/sessions (list) and /api/sessions/search are checked
 *  first by lookupHandler, so they never reach this prefix handler. */
async function sessionPrefixHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  // After /api/sessions/, split into segments: ["<id>"] or ["<id>", "messages"|"archive"]
  const segments = url.pathname.replace(/^\/api\/sessions\//, "").split("/").filter(Boolean);
  if (segments.length === 0) {
    // /api/sessions/ with nothing after — treat as list
    return sessionsListHandler(ctx);
  }
  if (segments.length === 1) {
    // /api/sessions/<id>
    if (ctx.method === "DELETE") return deleteSessionHandler(ctx);
    return sessionDetailHandler(ctx);
  }
  if (segments.length === 2) {
    // /api/sessions/<id>/messages or /api/sessions/<id>/archive
    if (segments[1] === "messages") return sessionMessagesHandler(ctx);
    if (segments[1] === "archive") return archiveSessionHandler(ctx);
  }
  throw new Error(`HTTP 404: unknown session route ${ctx.path}`);
}

async function sessionsSearchHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  const rows = await sessionsStore.search(q, 20);
  return SearchResponse.parse({ results: rows });
}

async function sessionLogHandler(ctx: DashboardRequestContext) {
  const url = new URL(ctx.path, "http://localhost");
  const id = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const messages = await sessionsStore.getMessages(id);
  return MessagesResponse.parse({ session_id: id, messages });
}

function modelOptionsHandler(): ModelOptionsResult {
  return ModelOptionsResult.parse({ providers: LOCAL_MODEL_CATALOG });
}

// ── Browser-only (run.py) fallback handlers ───────────────────────────
// These serve empty defaults for endpoints the Python dashboard would have
// answered in managed/attached mode. Only consulted when running the
// standalone web app (no Tauri shell, no backend on 127.0.0.1:9120), so the
// Vite proxy never forwards to a dead port. Each shape matches the Zod
// schema the caller parses with, keeping the UI error-free in browser dev.

function localConfigSchemaHandler() {
  // The Python backend returns the config schema dataclass fields; we return
  // an empty scaffold so useConfigSchema resolves cleanly and the settings
  // page doesn't error when there's no backend.
  return ConfigSchemaResponse.parse({ fields: {}, category_order: [] });
}

function localProfilesListHandler(): { profiles: unknown[] } {
  return { profiles: [] };
}

function localModelInfoHandler(): {
  model: string;
  provider: string;
  effective_context_length: number;
} {
  // Read the saved config so the UI shows the actually selected model after
  // 保存配置. The Python backend resolves model.* from config.yaml here;
  // we read the same fields from the local config store. On first run (no
  // config saved yet) this returns empty strings, which makes the settings
  // page show the setup prompt instead of a network-error toast.
  const config = readLocalConfig();
  const model = asRecord(config.model);
  const contextLen = typeof config.model_context_length === "number"
    ? config.model_context_length
    : 0;
  return {
    model: String(model.default ?? ""),
    provider: String(model.provider ?? ""),
    effective_context_length: contextLen,
  };
}

function localAnalyticsUsageHandler(ctx: DashboardRequestContext): unknown {
  const url = new URL(ctx.path, "http://localhost");
  const days = Number(url.searchParams.get("days") ?? 30);
  const zeroTotals = {
    total_input: 0,
    total_output: 0,
    total_tokens: 0,
    total_cache_read: 0,
    total_cache_write: 0,
    total_reasoning: 0,
    total_sessions: 0,
    total_api_calls: 0,
    avg_tokens_per_session: 0,
  };
  return {
    daily: [],
    by_model: [],
    top_sessions: [],
    totals: zeroTotals,
    comparison: { previous_totals: zeroTotals },
    period_days: days,
    skills: {
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      top_skills: [],
    },
  };
}

function localSkillsHandler(): unknown[] {
  return [];
}

function localMoaConfigHandler(): MoaConfigResponse {
  // Schema-valid empty MoA config: no presets, no default. MoaPanel reads
  // `moa.presets[selectedPreset]`; with an empty presets record it falls
  // through to the "MoA 配置不可用" alert — the correct UX for a backend
  // that doesn't serve /api/model/moa (pre-0.18 Core or standalone web).
  return MoaConfigResponse.parse({
    default_preset: "",
    active_preset: "",
    presets: {},
  });
}

function localLogsHandler(ctx: DashboardRequestContext): { file: string; lines: string[] } {
  const url = new URL(ctx.path, "http://localhost");
  const file = url.searchParams.get("file") ?? "agent";
  return LogsResponse.parse({ file, lines: [] });
}

function localProfileSoulHandler(ctx: DashboardRequestContext): { content: string; exists: boolean } {
  return ProfileSoulResponse.parse({ content: "", exists: false });
}

function localActiveProfileHandler(): { active: string; current: string } {
  return { active: "default", current: "default" };
}

export function registerLocalDashboardHandlers(): void {
  createDashboardRouter({
    "GET /api/status": dashboardStatusHandler,
    "GET /api/config": dashboardConfigHandler,
    "PUT /api/config": dashboardConfigPutHandler,
    // /api/env is local-first: the config page manages API keys directly in
    // the UI store (persisted to Rust KV / localStorage) without a backend.
    "GET /api/env": localEnvHandler,
    "PUT /api/env": localEnvPutHandler,
    "DELETE /api/env": localEnvDeleteHandler,
    "POST /api/env/reveal": localEnvRevealHandler,
    "GET /api/config/schema": localConfigSchemaHandler,
    "GET /api/model/info": localModelInfoHandler,
    "GET /api/model/moa": localMoaConfigHandler,
    "GET /api/webhooks": dashboardWebhooksHandler,
    "GET /api/pairing": dashboardPairingHandler,
    "GET /api/channels": dashboardChannelsHandler,
    "GET /api/plugins": dashboardPluginsHandler,
    "GET /api/themes": dashboardThemesHandler,
    "GET /api/fs/list": dashboardFsListHandler,
    "POST /api/upload": dashboardUploadHandler,
    "GET /api/media": dashboardMediaHandler,
    "GET /api/media/file": dashboardMediaFileHandler,
    "GET /api/mcp-servers": dashboardMcpServersHandler,
    "GET /api/profiles/active": dashboardActiveProfileHandler,
    "PUT /api/profiles/active": dashboardActiveProfileHandler,
    "POST /api/profiles/active": dashboardActiveProfileHandler,
    // /api/memory/providers/{name}/status is handled via prefix registry below.
    "GET /api/providers/oauth": dashboardOAuthProvidersHandler,
  });
  registerDashboardPrefixHandler("/api/memory/providers", dashboardMemoryProviderStatusHandler, "GET");

  // Local-first dashboard auth routes (dashboard local-auth phase).
  const authSessionStore = createInMemorySessionStore();

  // Local-first dashboard routes for the standalone (no-backend) mode:
  // the gateway client falls back to the in-process transport, and these
  // handlers give the REST pages (session list / detail / history) the same
  // JSON shapes the Python backend used to produce, so `use-sessions`,
  // `use-session` and `use-session-messages` keep working unchanged.
  registerDashboardHandler("/api/sessions", sessionsListHandler);
  // Session detail/messages/archive/delete use path-parameterized URLs like
  // /api/sessions/<id> and /api/sessions/<id>/messages. The router only does
  // exact + prefix matching (no {id} expansion), so register a single prefix
  // handler for /api/sessions/ that dispatches based on the path structure.
  // Exact routes (list, search) are checked first by lookupHandler, so they
  // are not shadowed.
  registerDashboardHandler("/api/sessions/search", sessionsSearchHandler);
  registerDashboardPrefixHandler("/api/sessions/", sessionPrefixHandler, "GET");
  registerDashboardPrefixHandler("/api/sessions/", sessionPrefixHandler, "DELETE");
  registerDashboardPrefixHandler("/api/sessions/", sessionPrefixHandler, "POST");
  registerDashboardPrefixHandler("/__hermes_session_log/", sessionLogHandler, "GET");
  registerDashboardHandler("/api/model/options", modelOptionsHandler);
  const authRouter = createAuthRoutes(new DashboardRouter(), {
    providers: [
      new BasicAuthProvider({
        users: {},
        sessionStore: authSessionStore,
        verifyPassword: async () => false,
      }),
      new TokenAuthProvider({
        secret: "hsk-local",
        sessionStore: authSessionStore,
      }),
    ],
    sessionStore: authSessionStore,
  });
  for (const route of authRouter.routes()) {
    const handler = authRouter.resolve(route.path, route.method);
    if (!handler) continue;
    if (route.kind === "prefix") {
      registerDashboardPrefixHandler(route.path, handler as DashboardRequestContextHandler, route.method);
    } else {
      registerDashboardHandler(route.path, handler as DashboardRequestContextHandler, route.method);
    }
  }

  // Browser-only (run.py) fallback routes: these serve empty defaults for
  // endpoints the Python dashboard would have answered in managed/attached
  // mode. Consulted only in standalone web mode (runtime.isLocalOnly()),
  // never in Tauri/attached mode where the real backend serves them.
  registerLocalOnlyHandler("/api/profiles", localProfilesListHandler);
  registerLocalOnlyHandler("/api/profiles/active", localActiveProfileHandler);
  registerLocalOnlyHandler("/api/profiles/active", localActiveProfileHandler, "POST");
  registerLocalOnlyPrefixHandler("/api/profiles/", localProfileSoulHandler, "GET");
  // /api/model/info is in the main registry (reads from the local config
  // store), so it doesn't need a local-only duplicate.
  registerLocalOnlyHandler("/api/analytics/usage", localAnalyticsUsageHandler);
  registerLocalOnlyHandler("/api/skills", localSkillsHandler);
  registerLocalOnlyHandler("/api/logs", localLogsHandler);

  // /api/env (GET/PUT/DELETE/reveal) and /api/model/moa are in the main
  // registry above — they are local-first and never proxy to a backend.

  // Browser-only fallbacks for managed-mode routes that call
  // window.hermesDesktop.* — these native commands don't exist in a plain
  // browser, so return safe empty defaults instead of crashing.
  registerLocalOnlyHandler("/api/mcp-servers", () => ({ servers: [] }));
  registerLocalOnlyHandler("/api/providers/oauth", () => ({ providers: [] }));
}

type DashboardRequestContextHandler = (ctx: DashboardRequestContext) => Promise<unknown> | unknown;

export { registerDashboardHandler, createDashboardRouter };
