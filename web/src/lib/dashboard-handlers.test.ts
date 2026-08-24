import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetUiStoreForTests, readUiValue } from "./ui-store";
import {
  dashboardConfigHandler,
  dashboardPairingHandler,
  dashboardStatusHandler,
  dashboardWebhooksHandler,
  registerLocalDashboardHandlers,
} from "./dashboard-handlers";
import { clearDashboardRegistry, getDashboardHandler, getLocalOnlyDashboardHandler } from "./dashboard-router";
import { ConfigSchemaResponse, EnvVarsResponse, MoaConfigResponse, MutationOkResponse, StatusResponse } from "@hermes/protocol";

const ctx = { path: "/", method: "GET", body: undefined, headers: {} } as const;

describe("dashboard-handlers", () => {
  beforeEach(() => {
    clearDashboardRegistry();
    __resetUiStoreForTests({});
  });

  it("returns a valid local-first status payload", async () => {
    const result = await dashboardStatusHandler();
    expect(() => StatusResponse.parse(result)).not.toThrow();
    expect(result.gateway_running).toBe(false);
    expect(result.active_sessions).toBe(0);
  });

  it("fills hermes_home from the desktop runtime info (stable work directory)", async () => {
    // Regression: the local-first /api/status stub shadows the Python backend
    // in managed mode (transport.ts shouldUseLocalDashboard), and it used to
    // hardcode hermes_home: undefined — so the health grid showed
    // "Hermes Home — 正在读取数据目录" forever even though the desktop's
    // HERMES_HOME is stable and known via runtime_info.process.hermesHome.
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = {
      hermesDesktop: {
        getRuntimeInfo: vi.fn(async () => ({
          mode: "managed",
          packaged: false,
          platform: "win32",
          arch: "x64",
          runtimeRoot: "",
          currentRecordPath: "",
          versionsDir: "",
          downloadsDir: "",
          gatewayRuntimeDir: "",
          updatesConfigured: false,
          process: {
            apiBaseUrl: "http://127.0.0.1:9120",
            gatewayUrl: "ws://127.0.0.1:9120/api/ws",
            hermesHome: "C:\\Users\\test\\.hermes",
            hermesHomeBase: "C:\\Users\\test\\.hermes",
            currentProfile: "default",
            ownsProcess: true,
            commandArgs: [],
            sessionTokenPresent: true,
            gatewayWsRelayActive: false,
          },
        })),
      },
    };
    try {
      const result = await dashboardStatusHandler();
      expect(result.hermes_home).toBe("C:\\Users\\test\\.hermes");
      expect(() => StatusResponse.parse(result)).not.toThrow();
    } finally {
      (globalThis as any).window = originalWindow;
    }
  });

  it("returns an empty config scaffold on first run", () => {
    const result = dashboardConfigHandler();
    expect(result).toEqual({});
  });

  it("returns empty webhooks and pairing collections", () => {
    expect(dashboardWebhooksHandler()).toEqual({ webhooks: [] });
    expect(dashboardPairingHandler()).toEqual({ pairings: [] });
  });

  it("registers all baseline routes including local-first config/env/model", () => {
    registerLocalDashboardHandlers();
    expect(getDashboardHandler("/api/status")).toBeDefined();
    expect(getDashboardHandler("/api/config")).toBeDefined();
    expect(getDashboardHandler("/api/config", "PUT")).toBeDefined();
    expect(getDashboardHandler("/api/webhooks")).toBeDefined();
    expect(getDashboardHandler("/api/pairing")).toBeDefined();
    // Local-first routes (no backend needed)
    expect(getDashboardHandler("/api/env")).toBeDefined();
    expect(getDashboardHandler("/api/env", "PUT")).toBeDefined();
    expect(getDashboardHandler("/api/env", "DELETE")).toBeDefined();
    expect(getDashboardHandler("/api/env/reveal", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/config/schema")).toBeDefined();
    expect(getDashboardHandler("/api/model/info")).toBeDefined();
    expect(getDashboardHandler("/api/model/moa")).toBeDefined();
  });

  it("registers auth routes", () => {
    registerLocalDashboardHandlers();
    expect(getDashboardHandler("/api/auth/providers")).toBeDefined();
    expect(getDashboardHandler("/api/auth/me")).toBeDefined();
    expect(getDashboardHandler("/api/auth/password-login", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/token-login", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/logout", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/refresh", "POST")).toBeDefined();
  });

  it("registers browser-only (run.py) fallback routes", () => {
    registerLocalDashboardHandlers();
    expect(getLocalOnlyDashboardHandler("/api/profiles")).toBeDefined();
    expect(getLocalOnlyDashboardHandler("/api/profiles/active")).toBeDefined();
    expect(getLocalOnlyDashboardHandler("/api/profiles/active", "POST")).toBeDefined();
    expect(getLocalOnlyDashboardHandler("/api/analytics/usage")).toBeDefined();
    expect(getLocalOnlyDashboardHandler("/api/skills")).toBeDefined();
    expect(getLocalOnlyDashboardHandler("/api/logs")).toBeDefined();
  });

  it("serves empty defaults for browser-only routes", () => {
    registerLocalDashboardHandlers();
    const logCtx = { path: "/api/logs?file=errors&lines=50", method: "GET", body: undefined, headers: {} };
    expect(getLocalOnlyDashboardHandler("/api/profiles")?.(ctx)).toEqual({ profiles: [] });
    expect(getLocalOnlyDashboardHandler("/api/skills")?.(ctx)).toEqual([]);
    expect(getLocalOnlyDashboardHandler("/api/logs?file=errors&lines=50")?.(logCtx)).toEqual({
      file: "errors", lines: [],
    });
  });

  // ── Local-first config (PUT /api/config) ──────────────────────────────

  it("PUT /api/config deep-merges the patch into the local config store", () => {
    registerLocalDashboardHandlers();
    const putCtx = {
      path: "/api/config",
      method: "PUT",
      body: { config: { model: { provider: "openai", default: "gpt-4o" } } },
      headers: {},
    };
    const result = getDashboardHandler("/api/config", "PUT")?.(putCtx);
    expect(MutationOkResponse.parse(result).ok).toBe(true);

    // GET should now return the merged config
    const config = getDashboardHandler("/api/config")?.(ctx) as Record<string, unknown>;
    expect(config.model).toEqual({ provider: "openai", default: "gpt-4o" });

    // A second PUT with a different top-level key should not clobber model
    const putCtx2 = {
      path: "/api/config",
      method: "PUT",
      body: { config: { providers: { openai: { name: "OpenAI" } } } },
      headers: {},
    };
    getDashboardHandler("/api/config", "PUT")?.(putCtx2);
    const config2 = getDashboardHandler("/api/config")?.(ctx) as Record<string, unknown>;
    expect(config2.model).toEqual({ provider: "openai", default: "gpt-4o" });
    expect(config2.providers).toEqual({ openai: { name: "OpenAI" } });
  });

  it("GET /api/model/info reads the saved model from local config", () => {
    registerLocalDashboardHandlers();
    // Before any save, returns empty
    const before = getDashboardHandler("/api/model/info")?.(ctx);
    expect(before).toEqual({ model: "", provider: "", effective_context_length: 0 });

    // Save a config with a model
    const putCtx = {
      path: "/api/config",
      method: "PUT",
      body: { config: { model: { provider: "anthropic", default: "claude-sonnet-4" }, model_context_length: 200000 } },
      headers: {},
    };
    getDashboardHandler("/api/config", "PUT")?.(putCtx);

    const after = getDashboardHandler("/api/model/info")?.(ctx) as { model: string; provider: string; effective_context_length: number };
    expect(after.model).toBe("claude-sonnet-4");
    expect(after.provider).toBe("anthropic");
    expect(after.effective_context_length).toBe(200000);
  });

  it("GET /api/config/schema returns a schema-valid empty scaffold", () => {
    registerLocalDashboardHandlers();
    const schema = getDashboardHandler("/api/config/schema")?.(ctx);
    expect(() => ConfigSchemaResponse.parse(schema)).not.toThrow();
  });

  // ── Local-first env vars (PUT/DELETE/reveal /api/env) ─────────────────

  it("PUT /api/env stores a key and GET /api/env surfaces it as EnvVarInfo", () => {
    registerLocalDashboardHandlers();
    const putCtx = {
      path: "/api/env",
      method: "PUT",
      body: { key: "OPENAI_API_KEY", value: "sk-test-123" },
      headers: {},
    };
    const result = getDashboardHandler("/api/env", "PUT")?.(putCtx);
    expect(MutationOkResponse.parse(result).ok).toBe(true);

    // GET should now show the key as set
    const env = getDashboardHandler("/api/env")?.(ctx) as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBeDefined();
    expect(() => EnvVarsResponse.parse(env)).not.toThrow();
    const info = env.OPENAI_API_KEY as { is_set: boolean; is_password: boolean; redacted_value: string | null };
    expect(info.is_set).toBe(true);
    expect(info.is_password).toBe(true);
    expect(info.redacted_value).not.toBe("sk-test-123"); // must be redacted
  });

  it("DELETE /api/env removes a stored key", () => {
    registerLocalDashboardHandlers();
    // Store a key first
    const putCtx = {
      path: "/api/env",
      method: "PUT",
      body: { key: "ANTHROPIC_API_KEY", value: "sk-ant-test" },
      headers: {},
    };
    getDashboardHandler("/api/env", "PUT")?.(putCtx);

    // Delete it
    const delCtx = {
      path: "/api/env",
      method: "DELETE",
      body: { key: "ANTHROPIC_API_KEY" },
      headers: {},
    };
    const result = getDashboardHandler("/api/env", "DELETE")?.(delCtx);
    expect(MutationOkResponse.parse(result).ok).toBe(true);

    // GET should not show the key
    const env = getDashboardHandler("/api/env")?.(ctx) as Record<string, unknown>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("POST /api/env/reveal returns the stored value", () => {
    registerLocalDashboardHandlers();
    const putCtx = {
      path: "/api/env",
      method: "PUT",
      body: { key: "GEMINI_API_KEY", value: "AIza-test" },
      headers: {},
    };
    getDashboardHandler("/api/env", "PUT")?.(putCtx);

    const revealCtx = {
      path: "/api/env/reveal",
      method: "POST",
      body: { key: "GEMINI_API_KEY" },
      headers: {},
    };
    const result = getDashboardHandler("/api/env/reveal", "POST")?.(revealCtx) as { value: string };
    expect(result.value).toBe("AIza-test");
  });

  it("GET /api/env returns a flat empty record on first run (no { env: {} })", () => {
    // Regression: the old handler returned { env: {} } which made Zod
    // validate the key "env" against EnvVarInfo and reject {} for missing
    // every required field → "环境变量加载失败".
    registerLocalDashboardHandlers();
    const env = getDashboardHandler("/api/env")?.(ctx);
    expect(env).toEqual({});
    expect(() => EnvVarsResponse.parse(env)).not.toThrow();
  });

  // ── MoA ───────────────────────────────────────────────────────────────

  it("GET /api/model/moa returns a schema-valid empty config", () => {
    registerLocalDashboardHandlers();
    const moa = getDashboardHandler("/api/model/moa")?.(ctx);
    expect(() => MoaConfigResponse.parse(moa)).not.toThrow();
    expect((moa as { presets: Record<string, unknown> }).presets).toEqual({});
  });

  // ── Session prefix dispatcher ─────────────────────────────────────────

  it("resolves /api/sessions/<id> via prefix handler (not exact {id} match)", () => {
    // Regression: routes were registered as /api/sessions/{id} but the router
    // does exact string matching with no {id} expansion, so a real session id
    // like /api/sessions/20260823_170325_ba3371 never matched and fell through
    // to the Vite proxy → dead 9120 → ECONNREFUSED.
    registerLocalDashboardHandlers();
    // The prefix handler should be found for any session-id path
    expect(getDashboardHandler("/api/sessions/20260823_170325_ba3371")).toBeDefined();
    expect(getDashboardHandler("/api/sessions/20260823_170325_ba3371/messages")).toBeDefined();
    expect(getDashboardHandler("/api/sessions/20260823_170325_ba3371", "DELETE")).toBeDefined();
    expect(getDashboardHandler("/api/sessions/20260823_170325_ba3371/archive", "POST")).toBeDefined();
    // Exact routes should still work
    expect(getDashboardHandler("/api/sessions")).toBeDefined();
    expect(getDashboardHandler("/api/sessions/search")).toBeDefined();
  });
});
