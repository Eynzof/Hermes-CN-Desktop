// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/api-docs.tsx — #/wander-memory/api: the HTTP/WebSocket
// API reference and the backend-connection guide, rendered in-app. Ported from
// WanderMemory `web/app/src/views/ApiDocsView.tsx` (content sourced from
// `docs/memory_api.md` §3–§4). Static component — no data fetching.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Badge, CopyButton } from "@hermes/shared-ui";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import s from "./api-docs.module.css";

type RestMethod = "GET" | "POST" | "DELETE";

interface RestRow {
  method: RestMethod;
  path: string;
  body?: string;
  returns: string;
  llm?: boolean;
  notes?: string;
}

const REST_ROWS: RestRow[] = [
  {
    method: "GET",
    path: "/v1/health",
    returns: '{ status: "ok", backends: Record<string, boolean>, model: string, backend?: string }',
    notes: "backends is {} in remote mode / probe failure; backend (client_type) only in remote mode",
  },
  {
    method: "GET",
    path: "/v1/backends",
    returns: "{ devices: [{ backend, index, name, total_mib }], remote?: boolean }",
    notes: "devices: [] with remote: true in remote mode",
  },
  { method: "GET", path: "/v1/models", returns: "{ model: string, reasoning: string }", notes: 'expect reasoning: "off"' },
  {
    method: "POST",
    path: "/v1/dialogues",
    body: "{ dialogue: string }",
    returns: "{ stored: MemoryItem[], collisions: CollisionSummary[], total: number }",
    llm: true,
    notes: "collisions[] is index-aligned with stored[]; dialogue may also be a JSON array string of {role, content}",
  },
  {
    method: "POST",
    path: "/v1/memories",
    body: "{ text: string, metadata?: object }",
    returns: "{ memory: MemoryItem, collision: CollisionSummary }",
    llm: true,
    notes: "collision is ALWAYS present",
  },
  {
    method: "GET",
    path: "/v1/memories?q=&top_k=",
    returns: "{ results: MemoryItem[] }",
    notes: "omit q for the full inventory; omit top_k for the server default",
  },
  { method: "GET", path: "/v1/memories/{id}", returns: "{ memory: MemoryItem }", notes: "404 not_found when absent" },
  { method: "DELETE", path: "/v1/memories/{id}", returns: "204 No Content (empty body)", notes: "404 not_found when absent" },
  {
    method: "POST",
    path: "/v1/context",
    body: "{ query: string, top_k?: number }",
    returns: "{ context: string }",
    notes: "empty string when nothing matches",
  },
  {
    method: "POST",
    path: "/v1/chat",
    body: "{ query: string }",
    returns: "{ reply: string }",
    llm: true,
    notes: "non-streaming; use WS chat with stream: true for deltas",
  },
  { method: "POST", path: "/v1/maintenance", returns: "{ total: number, errors: string[] }" },
];

interface WsOpRow {
  op: string;
  payload: string;
  result: string;
  notes?: string;
}

const WS_OPS_ROWS: WsOpRow[] = [
  { op: "health", payload: "{}", result: "HealthResponse" },
  { op: "models", payload: "{}", result: "ModelsResponse" },
  { op: "backends.list", payload: "{}", result: "BackendsResponse" },
  { op: "memories.add", payload: "{ text, metadata? }", result: "AddMemoryResponse" },
  { op: "memories.search", payload: "{ query, top_k? }", result: "{ results }" },
  { op: "memories.list", payload: "{}", result: "{ results }" },
  { op: "memories.get", payload: "{ id }", result: "{ memory }", notes: "id is a payload field, not a path segment" },
  { op: "memories.delete", payload: "{ id }", result: "null" },
  { op: "dialogues.add", payload: "{ dialogue }", result: "AddDialogueResponse" },
  { op: "context.build", payload: "{ query, top_k? }", result: "{ context }" },
  { op: "chat", payload: "{ query, stream: true }", result: "delta* frames, then done { reply }", notes: "omit stream for a single result frame" },
  { op: "maintenance.run", payload: "{}", result: "{ total, errors }" },
];

interface ErrorRow {
  code: string;
  http: string;
  meaning: string;
}

const ERROR_ROWS: ErrorRow[] = [
  { code: "bad_request", http: "400", meaning: "malformed request body / failed validation" },
  { code: "not_found", http: "404", meaning: "no memory with that id" },
  { code: "unknown_op", http: "400", meaning: "WS op not in the documented vocabulary — client bug" },
  { code: "conflict", http: "409", meaning: "memory system not started" },
  { code: "collision_conflict", http: "409", meaning: "concurrent write — retry" },
  { code: "llm_unavailable", http: "503", meaning: "LLM server unreachable; chat/dialogue fail until health recovers" },
  { code: "backend_probe_failed", http: "503", meaning: "device probe failed (non-blocking)" },
  { code: "collision_parse_failed", http: "502", meaning: "fail-closed: memory was NOT stored" },
  { code: "collision_validation_failed", http: "502", meaning: "fail-closed: memory was NOT stored" },
  { code: "collision_apply_failed", http: "500", meaning: "fail-closed: store restored to pre-operation state" },
  { code: "internal", http: "500", meaning: "unexpected server error" },
];

const TYPES_SNIPPET = `interface MemoryItem {
  id: string;
  memory: string;
  metadata: Record<string, unknown>;
}

// ALWAYS present on write responses
interface CollisionSummary {
  deleted: number;
  merged: number;
  stored_new: boolean;
  reason: string;
}

// error convention — every non-2xx response
interface ApiErrorBody { error: { code: string; message: string } }`;

const WS_SNIPPET = `// request
{ "id": 1, "op": "chat", "payload": { "query": "…", "stream": true } }

// frames
{ "id": 1, "ok": true, "type": "delta", "delta": "Based on" }
{ "id": 1, "ok": true, "type": "done",  "result": { "reply": "…" } }
{ "id": 1, "ok": true, "result": { … } } // non-streaming ops
{ "id": 1, "ok": false, "error": { "code": "…", "message": "…" } }

// keepalive
→ { "type": "ping" } // client, every 25 s
← { "id": null, "type": "pong", "ts": 1754… }`;

const CURL_SNIPPET = `# health
curl http://127.0.0.1:18400/v1/health

# add a memory (collision summary is always present)
curl -X POST http://127.0.0.1:18400/v1/memories \\
  -H 'Content-Type: application/json' \\
  -d '{"text": "The user is allergic to peanuts", "metadata": {"type": "fact"}}'

# search (CJK-safe — always URL-encode)
curl 'http://127.0.0.1:18400/v1/memories?q=%E8%8A%B1%E7%94%9F&top_k=5'

# import a dialogue (LLM path — allow generous timeouts)
curl -X POST http://127.0.0.1:18400/v1/dialogues \\
  -H 'Content-Type: application/json' \\
  -d '{"dialogue": "user: 我对花生过敏\\nassistant: 已记下"}'

# streaming chat over WebSocket (port 18401)
websocat ws://127.0.0.1:18401/v1/ws
> {"id": 1, "op": "chat", "payload": {"query": "what food must I avoid?", "stream": true}}`;

const BACKEND_SNIPPET = `# production: the API server itself hosts this SPA from web/dist
uv run python -m src.memory --model models/Qwen3.5-9B --device CUDA0 \\
    --web-dir web/dist
# → open http://127.0.0.1:18400/app/ (REST + static same-origin, no CORS)

# development: Vite dev server proxies REST; WS connects direct
# vite.config.ts:
# server: { proxy: { "/v1": "http://127.0.0.1:18400" } }
# base: "/app/" # matches static_prefix on the server
npm run dev # http://127.0.0.1:5173 → /v1 proxied to :18400
                      # ws://127.0.0.1:18401/v1/ws used directly (no proxy)`;

const PYTHON_SNIPPET = `# src/memory/api.py — additive serving changes (off by default)
MemoryAPIServer(
    ...,
    static_dir: Path | None = None, # e.g. Path("web/dist")
    static_prefix: str = "/app", # /v1 keeps routing priority
    cors_origins: list[str] | None = None,  # dev-only; default off
)

# static serving rules:
# GET /app/* → files under static_dir (path-traversal guarded)
# GET /app, /app/ → index.html
# GET / → 302 → /app/
# Cache-Control: no-cache for HTML; max-age=31536000, immutable
# for Vite's fingerprinted assets
#
# CORS (only when cors_origins is set): echo matched origin,
# allow GET/POST/DELETE/OPTIONS + Content-Type, answer preflight 204.`;

function MethodBadge({ m }: { m: RestMethod }) {
  const tone = m === "GET" ? "success" : m === "POST" ? "warning" : "danger";
  return (
    <Badge tone={tone} variant="outline" size="sm">
      {m}
    </Badge>
  );
}

function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className={s.codeBlock}>
      <div className={s.codeHead}>
        <span className={s.codeTitle}>{title ?? "code"}</span>
        <CopyButton text={code} variant="plain" size="xs" copiedLabel="已复制">
          copy
        </CopyButton>
      </div>
      <pre className={s.codeText}>{code}</pre>
    </div>
  );
}

type DocsTab = "rest" | "ws" | "connect";

function ApiDocsPage() {
  const [tab, setTab] = useState<DocsTab>("rest");

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.pageHead}>
        <div>
          <h1 className={s.pageTitle}>Memory Service API</h1>
          <p className={s.pageSub}>
            REST http://127.0.0.1:18400/v1 · WebSocket ws://127.0.0.1:18401/v1/ws · single-user, loopback-only
          </p>
        </div>
        <div className={s.tabs} role="tablist" aria-label="API 参考章节">
          {(["rest", "ws", "connect"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-active={tab === t ? "true" : undefined}
              onClick={() => setTab(t)}
              className={s.tab}
            >
              {t === "rest" ? "REST reference" : t === "ws" ? "WebSocket protocol" : "connecting the backend"}
            </button>
          ))}
        </div>
      </div>

      {tab === "rest" ? (
        <div className={s.sections}>
          <WanderMemorySection title="Shared types">
            <CodeBlock code={TYPES_SNIPPET} title="types (§3.1, §4.1)" />
          </WanderMemorySection>

          <WanderMemorySection title="Endpoints">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>method</th>
                    <th className={s.th}>path</th>
                    <th className={s.th}>body</th>
                    <th className={s.th}>returns</th>
                    <th className={s.th}>notes</th>
                  </tr>
                </thead>
                <tbody>
                  {REST_ROWS.map((r) => (
                    <tr key={r.method + r.path} className={s.tr}>
                      <td className={s.td}>
                        <MethodBadge m={r.method} />
                      </td>
                      <td className={`${s.td} ${s.monoCell}`}>
                        {r.path}
                        {r.llm ? <span className={s.llmChip}>LLM ~seconds</span> : null}
                      </td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.body ?? "—"}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.returns}</td>
                      <td className={s.td}>{r.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.note}>
              Client rules: 10 s timeout on no-LLM endpoints; no client timeout on /dialogues and /chat. Encode
              queries with URLSearchParams. DELETE returns 204 with an empty body — treat it as success, not a parse
              error.
            </p>
          </WanderMemorySection>

          <WanderMemorySection title="Error codes">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>code</th>
                    <th className={s.th}>http</th>
                    <th className={s.th}>meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((e) => (
                    <tr key={e.code} className={s.tr}>
                      <td className={`${s.td} ${s.errorCell}`}>{e.code}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{e.http}</td>
                      <td className={s.td}>{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </WanderMemorySection>

          <WanderMemorySection title="Examples">
            <CodeBlock code={CURL_SNIPPET} title="curl" />
          </WanderMemorySection>
        </div>
      ) : null}

      {tab === "ws" ? (
        <div className={s.sections}>
          <WanderMemorySection title="Frame shapes">
            <CodeBlock code={WS_SNIPPET} title="ws://127.0.0.1:18401/v1/ws (§4.2)" />
            <p className={s.note}>
              Requests carry a monotonically increasing id; the matching frame resolves them. Frames with id: null are
              server-control (pong). Whitespace caveat: server chunking drops whitespace at chunk boundaries — display
              deltas verbatim but treat the done frame's reply as authoritative.
            </p>
          </WanderMemorySection>

          <WanderMemorySection title="Ops">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>op</th>
                    <th className={s.th}>payload</th>
                    <th className={s.th}>result</th>
                    <th className={s.th}>notes</th>
                  </tr>
                </thead>
                <tbody>
                  {WS_OPS_ROWS.map((r) => (
                    <tr key={r.op} className={s.tr}>
                      <td className={`${s.td} ${s.opCell}`}>{r.op}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.payload}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.result}</td>
                      <td className={s.td}>{r.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </WanderMemorySection>

          <WanderMemorySection title="Connection lifecycle">
            <ul className={s.list}>
              <li>
                Keepalive: client sends <code className={s.inlineCode}>{"{\"type\":\"ping\"}"}</code> every 25 s;
                server answers pong.
              </li>
              <li>
                Dead-socket detection: no frame of any kind for 60 s while a request is pending → reconnect and fail
                pending requests with llm_unavailable.
              </li>
              <li>Reconnect: exponential backoff 250 ms → 8 s with jitter, automatic on close/error.</li>
              <li>Pending requests are failed, never replayed — writes are not idempotent and the collision pipeline is stateful.</li>
              <li>One shared socket per page; the server runs blocking memory calls in worker threads, so ops interleave.</li>
            </ul>
          </WanderMemorySection>
        </div>
      ) : null}

      {tab === "connect" ? (
        <div className={s.sections}>
          <WanderMemorySection title="Topology">
            <p className={s.note}>
              In production the memory API server itself serves this SPA, so REST calls are same-origin and no CORS
              machinery is needed. The WebSocket lives on a different port (18401) — a different origin — but the WS
              handshake is not subject to same-origin policy and the server enforces no Origin allowlist, so the SPA
              connects cross-port without any server change.
            </p>
            <CodeBlock code={BACKEND_SNIPPET} title="run" />
          </WanderMemorySection>

          <WanderMemorySection title="Server-side serving (small, additive)">
            <CodeBlock code={PYTHON_SNIPPET} title="src/memory/api.py" />
          </WanderMemorySection>

          <WanderMemorySection title="Pointing this UI at your backend">
            <ul className={s.list}>
              <li>
                Default endpoints: REST <code className={s.inlineCode}>http://127.0.0.1:18400/v1</code>, WS{" "}
                <code className={s.inlineCode}>ws://127.0.0.1:18401/v1/ws</code>.
              </li>
              <li>
                Served on port 18400, the UI derives both from location.host automatically (port substitution 18400 →
                18401).
              </li>
              <li>
                Overrides: <code className={s.inlineCode}>?api=</code> query param, or the Status → endpoint settings
                row (ui-store keys <code className={s.inlineCode}>wander-memory.apiOrigin</code> /{" "}
                <code className={s.inlineCode}>wander-memory.wsUrl</code>).
              </li>
              <li>No auth headers anywhere. Binding stays 127.0.0.1 — if you re-bind the API to LAN, the SPA inherits that exposure.</li>
              <li>The remote-backend api_key never leaves the server; the frontend never sees it.</li>
            </ul>
          </WanderMemorySection>
        </div>
      ) : null}
      </div>
    </div>
  );
}

export function WanderMemoryApiDocsRoute() {
  return (
    <WanderMemoryLayout title="API 参考" sub="MemOS · API">
      <ApiDocsPage />
    </WanderMemoryLayout>
  );
}
