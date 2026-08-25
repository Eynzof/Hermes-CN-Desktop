// Shared constants + paths for the E2E backend harness. Importable from both
// the Node orchestrator (start-backend.mjs) and the protocol smoke test.
  import { fileURLToPath } from "node:url";
  import { dirname, resolve } from "node:path";
  import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// e2e/harness -> e2e
export const E2E_DIR = resolve(__dirname, "..");
// e2e -> Hermes-CN-Desktop
export const DESKTOP_DIR = resolve(E2E_DIR, "..");
// The Core backend repo. Defaults to the sibling checkout; override in CI.
export const CORE_DIR =
  process.env.HERMES_CORE_DIR || resolve(DESKTOP_DIR, "..", "Hermes-CN-Core");
// A Python venv lays its interpreter under bin/ on POSIX but Scripts/ (with a
// .exe suffix) on Windows — pick the platform-correct default so the harness
// finds the Core venv without HERMES_CORE_PYTHON overrides on Windows.
const VENV_PY_DEFAULT =
  process.platform === "win32"
    ? resolve(CORE_DIR, ".venv", "Scripts", "python.exe")
    : resolve(CORE_DIR, ".venv", "bin", "python");
export const VENV_PY = process.env.HERMES_CORE_PYTHON || VENV_PY_DEFAULT;

export const RUNTIME_DIR = resolve(E2E_DIR, ".runtime");
export const HERMES_HOME = resolve(RUNTIME_DIR, "hermes-home");
export const UPLOAD_DIR = resolve(RUNTIME_DIR, "uploads");
// Stub SPA dist so the dashboard serves *something* at `/` (we use the desktop's
// own Vite frontend; Core's UI is irrelevant here). HERMES_WEB_DIST overrides
// the built-in web_dist path, letting us pass --skip-build without a real build.
export const WEB_DIST = resolve(RUNTIME_DIR, "web-dist");

export const FAKE_MODEL_PORT = Number(process.env.E2E_FAKE_MODEL_PORT || 8099);
export const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT || 9120);
export const VITE_PORT = Number(process.env.E2E_VITE_PORT || 9545);

export const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_PORT}`;
export const FAKE_MODEL_BASE = `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`;
export const FAKE_MODEL_HEALTH = `http://127.0.0.1:${FAKE_MODEL_PORT}/health`;

// Loopback has no auth gate, but we pin a stable token so the dev-server token
// scrape is deterministic.
  export const DASHBOARD_TOKEN = process.env.E2E_DASHBOARD_TOKEN || "e2e-token";
  export const MODEL_ID = "fake-model";

  /**
   * Optional external model config for the harness backend, loaded from a JSON
   * file passed as a command argument (env var `E2E_MODEL_CONFIG`). The file
   * uses the desktop model-config shape:
   *
   *   { "model": "…", "url": "https://…", "api_key": "…",
   *     "type": "openai_legacy", "max_context_size": 1024000 }
   *
   * When set, the harness configures Core's "custom" provider to point at that
   * OpenAI-compatible endpoint (custom URL + custom API key) instead of the
   * local fake model, so the app sees a real configured model (the first-run
   * onboarding dialog stays hidden) and real model calls are exercised.
   * Nothing is hard-coded in the tests — the path comes from the command line:
   *
   *   E2E_MODEL_CONFIG=C:/dev/ds_flash.json pnpm --filter @hermes/e2e test
   */
  export function externalModelConfig() {
    const path = process.env.E2E_MODEL_CONFIG?.trim() ?? "";
    if (!path) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      model: raw.model,
      url: raw.url,
      apiKey: raw.api_key,
      apiMode: raw.type === "anthropic_messages" ? "anthropic_messages" : "chat_completions",
      contextLength: Number(raw.max_context_size) || 200000,
      maxTokens: Number(raw.max_tokens) || 2048,
    };
  }

  // Minimal config.yaml that points Core's "custom" provider at the local fake
  // model and force-enables native vision routing (model.supports_vision short-
  // circuits the models.dev capability lookup — see Core agent/image_routing.py).
  // With E2E_MODEL_CONFIG set, the same "custom" provider targets the external
  // OpenAI-compatible endpoint from the JSON file instead.
  export function configYaml() {
    const ext = externalModelConfig();
    if (ext) {
      return [
        "model:",
        "  provider: custom",
        `  default: ${ext.model}`,
        `  base_url: ${ext.url}`,
        `  api_key: ${ext.apiKey}`,
        `  api_mode: ${ext.apiMode}`,
        `  context_length: ${ext.contextLength}`,
        `  max_tokens: ${ext.maxTokens}`,
        "memory:",
        "  memory_enabled: false",
        "  user_profile_enabled: false",
        "compression:",
        "  enabled: false",
        "",
      ].join("\n");
    }
    return [
      "model:",
      "  provider: custom",
      `  default: ${MODEL_ID}`,
      `  base_url: ${FAKE_MODEL_BASE}`,
      "  [REDACTED]",
      "  supports_vision: true",
      // Core rejects models advertising < 64K context; pin a roomy value.
      "  context_length: 200000",
      "  max_tokens: 256",
      "memory:",
      "  memory_enabled: false",
      "  user_profile_enabled: false",
      "compression:",
      "  enabled: false",
      "",
    ].join("\n");
  }

// Env shared by every Core subprocess (dashboard + smoke helpers).
export function coreEnv() {
  const ext = externalModelConfig();
  const openAiBase = ext?.url ?? FAKE_MODEL_BASE;
  const openAiKey = ext?.apiKey ?? "e2e-test-key";
  return {
    ...process.env,
    HERMES_HOME,
    HERMES_WEB_DIST: WEB_DIST,
    HERMES_DASHBOARD_SESSION_TOKEN: DASHBOARD_TOKEN,
    // Belt-and-suspenders: config.base_url already wins, but these guarantee the
    // OpenAI-compatible client targets the configured server even if provider
    // resolution is surprising.
    OPENAI_BASE_URL: openAiBase,
    OPENAI_API_KEY: openAiKey,
    // Keep model-catalog/telemetry lookups from reaching the network in CI.
    HERMES_NO_ANALYTICS: "1",
  };
}
