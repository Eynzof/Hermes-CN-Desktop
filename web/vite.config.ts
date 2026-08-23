import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync, execSync } from "node:child_process";
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

/**
 * Vite's dev port, resolved at startup.
 *
 * Windows reserves whole TCP port ranges for Hyper-V / WSL2 / WinNAT
 * ("excluded port ranges" — see `netsh interface ipv4 show excludedportrange
 * protocol=tcp`). Binding to a reserved port then fails with EACCES even
 * though nothing is listening, and the reserved ranges move across reboots —
 * so a hard-coded 9545 is not safe. We probe the exact addresses Node will
 * bind for `localhost` and, if the preferred port is blocked, fall back to a
 * free port (strictPort then applies to the chosen port).
 *
 * The probe is skipped when E2E_VITE_PORT is explicitly set (run.py / the e2e
 * harness have already verified the port) and under `tauri dev`, whose devUrl
 * is a static http://localhost:9545 — silently moving ports there would just
 * leave the WebView pointing at a dead URL, so it fails loudly instead.
 */
function resolveDevServerPort(): number {
  const preferred = Number(process.env.E2E_VITE_PORT || 9545);
  if (process.env.E2E_VITE_PORT || process.env.TAURI_ENV_PLATFORM) return preferred;

  const probeScript = `
    const net = require("net");
    const dns = require("dns");
    const probe = (port, host) => new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    (async () => {
      const preferred = Number(process.argv[1]);
      const addrs = await new Promise((resolve) => {
        dns.lookup("localhost", { all: true }, (err, res) => {
          resolve(err ? [{ address: "127.0.0.1" }] : res);
        });
      });
      const usable = async (port) => {
        for (const { address } of addrs) {
          if (!(await probe(port, address))) return false;
        }
        return true;
      };
      let port = (await usable(preferred)) ? preferred : null;
      if (port == null) {
        port = await new Promise((resolve) => {
          const server = net.createServer();
          server.once("error", () => resolve(null));
          server.listen(0, "127.0.0.1", () => {
            const p = server.address().port;
            server.close(() => resolve(p));
          });
        });
        if (port == null || !(await usable(port))) process.exit(1);
      }
      process.stdout.write(String(port));
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ["-e", probeScript, String(preferred)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    const port = Number(out);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("unexpected probe result: " + out);
    }
    if (port !== preferred) {
      console.warn(
        "\n[vite] Port " +
          preferred +
          " is blocked by the OS (Windows excluded port range, usually reserved " +
          "by Hyper-V/WSL2). Falling back to port " +
          port +
          ".\n",
      );
    }
    return port;
  } catch {
    // Probe failed — let Vite try the preferred port and surface its own error.
    return preferred;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MemOS (WanderMemory) dev proxy targets — port-shift aware at config load.
// The MemOS backend is CORS-free by default, so every proxy entry needs
// `changeOrigin: true`. This stays SYNCHRONOUS (vite config load): no network
// probe here — the browser-side discovery in
// `web/src/lib/wander-memory/endpoints.ts` handles live probing.
// ─────────────────────────────────────────────────────────────────────────────
interface WanderMemoryProxyTargets {
  apiOrigin: string | null;
  fsOrigin: string | null;
}

function envString(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function readPortsFile(candidate: string): { api: number; fs: number } | null {
  try {
    const raw = JSON.parse(readFileSync(candidate, "utf8")) as { api?: unknown; fs?: unknown };
    const api = typeof raw.api === "number" && Number.isInteger(raw.api) && raw.api > 0 ? raw.api : null;
    if (api === null) return null;
    // `fs` may be missing in a partial ports file — derive api+2 (plan Appendix L).
    const fs = typeof raw.fs === "number" && Number.isInteger(raw.fs) && raw.fs > 0 ? raw.fs : api + 2;
    return { api, fs };
  } catch {
    return null; // unreadable / not yet written — fall through to the next candidate
  }
}

function resolveWanderMemoryTargets(): WanderMemoryProxyTargets {
  // 1. env override (both the runtime process.env form and the VITE_ form)
  const apiOrigin =
    envString("WANDER_MEMORY_API_ORIGIN") ?? envString("VITE_WANDER_MEMORY_API_ORIGIN");
  const fsOrigin =
    envString("WANDER_MEMORY_FS_ORIGIN") ?? envString("VITE_WANDER_MEMORY_FS_ORIGIN");
  if (apiOrigin) return { apiOrigin, fsOrigin };

  // 2. ports file: <data_dir>/wander_memory_ports.json in likely data dirs
  const repoRoot = resolve(__dirname, "..");
  const candidates: string[] = [];
  const dataDir = envString("WANDER_MEMORY_DATA_DIR");
  if (dataDir) candidates.push(join(dataDir, "wander_memory_ports.json"));
  candidates.push(
    join(repoRoot, "..", "Wander-Memory", "data", "wander_memory_ports.json"),
    join(homedir(), ".wander-memory", "wander_memory_ports.json"),
    join(process.cwd(), "data", "wander_memory_ports.json"),
  );
  for (const candidate of candidates) {
    const ports = readPortsFile(candidate);
    if (ports) {
      return {
        apiOrigin: `http://127.0.0.1:${ports.api}`,
        fsOrigin: `http://127.0.0.1:${ports.fs}`,
      };
    }
  }

  // 3. defaults
  return { apiOrigin: null, fsOrigin: null };
}

const WANDER_MEMORY_PROXY_TARGETS = resolveWanderMemoryTargets();
const WANDER_MEMORY_API_DEFAULT = "http://127.0.0.1:18400";
const WANDER_MEMORY_FS_DEFAULT = "http://127.0.0.1:18402";
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

function hermesLlmProxyPlugin(): Plugin {
  // CORS-free proxy for LLM API calls from the browser. The local-agent's
  // callRemoteModel routes /chat/completions through this proxy to avoid
  // cross-origin restrictions when calling e.g. api.kimi.com directly.
  return {
    name: "hermes-dev-llm-proxy",
    configureServer(server) {
      server.middlewares.use("/__llm_proxy", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const target = url.searchParams.get("target");
        if (!target) {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: "missing target query" }));
          return;
        }
        // Collect request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const body = Buffer.concat(chunks);
        try {
          const upstream = await fetch(target, {
            method: req.method ?? "POST",
            headers: {
              "Content-Type": "application/json",
              ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
            },
            body: body.length > 0 ? body : undefined,
          });
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
          const respBody = await upstream.text();
          res.end(respBody);
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
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
  plugins: [react(), hermesTokenPlugin(), hermesSessionLogPlugin(), hermesLlmProxyPlugin(), hermesSessionArchivePlugin()],
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
    port: resolveDevServerPort(),
    strictPort: true,
    proxy: {
      "/api": {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        ws: true,
      },
      // MemOS FS proxy must be registered BEFORE /v1 — Vite matches proxy
      // contexts in registration order (see vite proxyMiddleware).
      "/v1/fs": {
        target: WANDER_MEMORY_PROXY_TARGETS.fsOrigin ?? WANDER_MEMORY_FS_DEFAULT,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/v1\/fs/, "/v1"),
      },
      "/v1": {
        target: WANDER_MEMORY_PROXY_TARGETS.apiOrigin ?? WANDER_MEMORY_API_DEFAULT,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Split heavy third-party libraries into their own chunks so the app
    // shell + route chunks stay small and, critically, Rollup never merges a
    // big vendor (e.g. the 3.3 MB mermaid bundle) into the startup chunk.
    // Without manualChunks the app bundle used to merge into the mermaid
    // chunk, forcing ~3.8 MB of JS to download+parse before first paint.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("xterm")) return "vendor-terminal";
          if (id.includes("recharts")) return "vendor-charts";
          if (id.includes("mermaid") || id.includes("cytoscape") || id.includes("dagre") || id.includes("elkjs") || id.includes("khroma")) return "vendor-mermaid";
          if (id.includes("cmdk") || id.includes("@radix-ui") || id.includes("@floating-ui")) return "vendor-ui";
          if (id.includes("qrcode")) return "vendor-qrcode";
          if (id.includes("@dnd-kit")) return "vendor-dnd";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("katex") || id.includes("streamdown") || id.includes("rehype") || id.includes("remark") || id.includes("unified")) return "vendor-markdown";
          return undefined;
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
