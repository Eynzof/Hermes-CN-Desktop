// Shared constants + paths for the E2E backend harness. Importable from both
// the Node orchestrator (start-backend.mjs) and the protocol smoke test.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

// Minimal config.yaml that points Core's "custom" provider at the local fake
// model and force-enables native vision routing (model.supports_vision short-
// circuits the models.dev capability lookup — see Core agent/image_routing.py).
export function configYaml() {
  return [
    "model:",
    "  provider: custom",
    `  default: ${MODEL_ID}`,
    `  base_url: ${FAKE_MODEL_BASE}`,
    "  api_key: e2e-test-key",
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
  return {
    ...process.env,
    HERMES_HOME,
    HERMES_WEB_DIST: WEB_DIST,
    HERMES_DASHBOARD_SESSION_TOKEN: DASHBOARD_TOKEN,
    // Belt-and-suspenders: config.base_url already wins, but these guarantee the
    // OpenAI-compatible client targets the fake server even if provider
    // resolution is surprising.
    OPENAI_BASE_URL: FAKE_MODEL_BASE,
    OPENAI_API_KEY: "e2e-test-key",
    // Keep model-catalog/telemetry lookups from reaching the network in CI.
    HERMES_NO_ANALYTICS: "1",
  };
}
