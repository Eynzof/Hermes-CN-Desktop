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
import { readUiValue } from "./ui-store";
import { registerDashboardHandler, createDashboardRouter, registerDashboardPrefixHandler, type DashboardRequestContext } from "./dashboard-router";
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

const DEFAULT_STATUS = {
  ok: true,
  platform: "desktop",
  version: versionLabel(DESKTOP_VERSION) ?? "0.0.0",
  connection_mode: "managed",
};

export function dashboardStatusHandler() {
  return DEFAULT_STATUS;
}

export function dashboardConfigHandler() {
  // Phase 1: return the same scaffold as the Python /api/config endpoint so
  // that existing hooks deserialize safely. The real config YAML read will
  // move to a Rust command once the managed runtime is removed.
  return {
    config: readUiValue<Record<string, unknown>>("hermes.active-config", {}),
  };
}

export function dashboardEnvHandler() {
  return { env: {} };
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
export function registerLocalDashboardHandlers(): void {
  createDashboardRouter({
    "GET /api/status": dashboardStatusHandler,
    "GET /api/config": dashboardConfigHandler,
    "GET /api/env": dashboardEnvHandler,
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

  // Local-first dashboard auth routes (Phase 0 of plans/web-dashboard.md).
  const authSessionStore = createInMemorySessionStore();
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
}

type DashboardRequestContextHandler = (ctx: DashboardRequestContext) => Promise<unknown> | unknown;

export { registerDashboardHandler, createDashboardRouter };
