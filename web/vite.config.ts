import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import type { Plugin } from "vite";
import { sessionLogToMessages } from "../packages/protocol/src/session-log.ts";

function hermesTokenPlugin(): Plugin {
  return {
    name: "hermes-dev-token",
    configureServer(server) {
      server.middlewares.use("/__hermes_token", async (_req, res) => {
        // Always refetch — the dashboard regenerates _SESSION_TOKEN on every
        // restart, so caching here means every dashboard kick → vite serves
        // a stale token → /api/ws closes with 401 → browser shows
        // "WebSocket connection failed" until vite is restarted too.
        let token: string | null = null;
        try {
          const html = await fetch(`${process.env.HERMES_DASHBOARD_ORIGIN || "http://127.0.0.1:9120"}/`).then((r) => r.text());
          const match = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
          token = match?.[1] ?? null;
        } catch {
          token = null;
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ token }));
      });
    },
  };
}

function hermesSessionLogPlugin(): Plugin {
  return {
    name: "hermes-dev-session-log",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const prefix = "/__hermes_session_log/";
        if (!url.pathname.startsWith(prefix)) {
          next();
          return;
        }

        const sessionId = decodeURIComponent(url.pathname.slice(prefix.length));
        res.setHeader("Content-Type", "application/json");

        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: "invalid session id" }));
          return;
        }

        try {
          const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
          const logPath = join(hermesHome, "sessions", `session_${sessionId}.json`);
          const raw = await readFile(logPath, "utf8");
          const log = JSON.parse(raw) as Record<string, unknown>;
          res.end(JSON.stringify({
            session_id: sessionId,
            messages: sessionLogToMessages(sessionId, log),
          }));
        } catch {
          res.statusCode = 404;
          res.end(JSON.stringify({ message: "session log not found" }));
        }
      });
    },
  };
}

// Override with HERMES_DASHBOARD_ORIGIN to point dev server at a different
// dashboard without disturbing a user's separately installed dashboard on 9119.
const API_PROXY_TARGET = process.env.HERMES_DASHBOARD_ORIGIN || "http://127.0.0.1:9120";
const devArchivedSessions = new Set<string>();

function gitShortCommit(): string {
  if (process.env.HERMES_BUILD_COMMIT) return process.env.HERMES_BUILD_COMMIT;
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      cwd: resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function gitCommitDate(): string {
  if (process.env.HERMES_BUILD_DATE) return process.env.HERMES_BUILD_DATE;
  try {
    return execSync("git log -1 --format=%cI HEAD", {
      cwd: resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function desktopAppVersion(): string {
  if (process.env.HERMES_DESKTOP_APP_VERSION) return process.env.HERMES_DESKTOP_APP_VERSION;
  const pkgPath = resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${pkgPath} must define a desktop version`);
  }
  return pkg.version.trim();
}

function hermesHomePath(): string {
  return process.env.HERMES_DESKTOP_HERMES_HOME || process.env.HERMES_HOME || join(homedir(), ".hermes");
}

async function readArchiveState(): Promise<{ archivedSessions: string[] }> {
  return { archivedSessions: Array.from(devArchivedSessions) };
}

async function writeArchiveState(state: { archivedSessions: string[] }): Promise<void> {
  devArchivedSessions.clear();
  for (const id of state.archivedSessions) {
    const cleanId = typeof id === "string" ? id.trim() : "";
    if (cleanId) devArchivedSessions.add(cleanId);
  }
}

function archiveRouteSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]);
    return sessionId.trim() || null;
  } catch {
    return null;
  }
}

function sendJson(res: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function fetchHeaders(rawHeaders: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (["connection", "content-length", "host"].includes(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function filteredDashboardResponse(
  path: string,
  headers: Headers,
): Promise<{ status: number; contentType: string; body: string }> {
  const upstream = await fetch(new URL(path, API_PROXY_TARGET), {
    headers,
  });
  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.ok) return { status: upstream.status, contentType, body };

  const url = new URL(path, "http://localhost");
  if (url.searchParams.get("include_archived") === "true") return { status: upstream.status, contentType, body };

  const archived = new Set((await readArchiveState()).archivedSessions);
  if (archived.size === 0) return { status: upstream.status, contentType, body };

  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    if (url.pathname === "/api/sessions" && Array.isArray(data.sessions)) {
      const before = data.sessions.length;
      const sessions = data.sessions.filter((session) => {
        if (!session || typeof session !== "object") return true;
        const id = (session as { id?: unknown }).id;
        return typeof id !== "string" || !archived.has(id);
      });
      data.sessions = sessions;
      if (typeof data.total === "number") {
        data.total = Math.max(0, data.total - (before - sessions.length));
      }
      return { status: upstream.status, contentType: "application/json", body: JSON.stringify(data) };
    }

    if (url.pathname === "/api/sessions/search" && Array.isArray(data.results)) {
      data.results = data.results.filter((result) => {
        if (!result || typeof result !== "object") return true;
        const id = (result as { session_id?: unknown }).session_id;
        return typeof id !== "string" || !archived.has(id);
      });
      return { status: upstream.status, contentType: "application/json", body: JSON.stringify(data) };
    }
  } catch {}

  return { status: upstream.status, contentType, body };
}

function hermesSessionArchivePlugin(): Plugin {
  return {
    name: "hermes-dev-session-archive",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const method = (req.method ?? "GET").toUpperCase();
        const rawUrl = req.url ?? "/";
        const url = new URL(rawUrl, "http://localhost");
        const sessionId = archiveRouteSessionId(url.pathname);

        if (sessionId) {
          if (!["POST", "PUT", "DELETE"].includes(method)) {
            sendJson(res, 405, { message: "method not allowed" });
            return;
          }

          const state = await readArchiveState();
          const archived = new Set(state.archivedSessions);
          if (method === "DELETE") {
            archived.delete(sessionId);
          } else {
            archived.add(sessionId);
          }
          await writeArchiveState({ archivedSessions: Array.from(archived) });
          sendJson(res, 200, { ok: true, session_id: sessionId, archived: method !== "DELETE" });
          return;
        }

        if (method === "GET" && ["/api/sessions", "/api/sessions/search"].includes(url.pathname)) {
          try {
            const result = await filteredDashboardResponse(rawUrl, fetchHeaders(req.headers));
            res.statusCode = result.status;
            res.setHeader("Content-Type", result.contentType);
            res.end(result.body);
          } catch (error) {
            sendJson(res, 502, {
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  // Packaged Tauri builds load web/dist through a custom protocol, so asset
  // URLs must stay relative instead of resolving to tauri://localhost/assets/*.
  base: "./",
  plugins: [react(), hermesTokenPlugin(), hermesSessionLogPlugin(), hermesSessionArchivePlugin()],
  define: {
    "import.meta.env.VITE_HERMES_BUILD_COMMIT": JSON.stringify(gitShortCommit()),
    "import.meta.env.VITE_HERMES_BUILD_DATE": JSON.stringify(gitCommitDate()),
    "import.meta.env.VITE_HERMES_DESKTOP_VERSION": JSON.stringify(desktopAppVersion()),
    "import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN": JSON.stringify(API_PROXY_TARGET),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 9545,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
