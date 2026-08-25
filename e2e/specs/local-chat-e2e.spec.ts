import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

// ── Local-first E2E: no backend, real LLM ─────────────────────────────
//
// Verifies the full local-first chat loop with a REAL LLM API:
//   1. Start Vite in standalone web mode (no Python backend, no Tauri shell)
//   2. Seed local config + API key via the in-browser REST handlers
//   3. Create a new session, send "hello"
//   4. Assert a real reply arrives from the remote model (not the echo fallback)
//
// The local-agent.ts streamLocalTurn reads the model config from the UI store
// (hermes.active-config + hermes.env-vars) and calls the OpenAI-compatible
// /v1/chat/completions endpoint. If no config is found it falls back to echo
// mode — the test explicitly checks the reply is NOT the echo prefix.
//
// Prerequisites (one of):
//   - DEEPSEEK_API_KEY env var  → uses DeepSeek API
//   - KIMI_API_KEY env var      → uses Kimi/Moonshot API
//
// Run:
//   KIMI_API_KEY=sk-... pnpm --filter @hermes/e2e exec playwright test --config=playwright.local.config.ts

interface ProviderSpec {
  envVar: string;
  providerId: string;
  baseUrl: string;
  model: string;
}

const PROVIDERS: ProviderSpec[] = [
  {
    envVar: "DEEPSEEK_API_KEY",
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  {
    envVar: "KIMI_API_KEY",
    providerId: "kimi-coding",
    // The user's config.yaml uses https://api.kimi.com/coding as base_url
    // with model "kimi-for-coding". The Kimi for Coding API is
    // OpenAI-compatible at this endpoint.
    baseUrl: "https://api.kimi.com/coding",
    model: "kimi-for-coding",
  },
];

function resolveProvider(): { spec: ProviderSpec; apiKey: string; contextLength?: number } | null {
  // Command-argument model config: a JSON file with the desktop model-config
  // shape ({ model, url, api_key, type, max_context_size }). Nothing about the
  // endpoint / key is hard-coded here — the path comes from E2E_MODEL_CONFIG:
  //
  //   E2E_MODEL_CONFIG=C:/dev/ds_flash.json pnpm --filter @hermes/e2e exec playwright test --config=playwright.local.config.ts
  const configPath = (process.env.E2E_MODEL_CONFIG ?? "").trim();
  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.model && cfg.url && cfg.api_key) {
        return {
          spec: {
            envVar: "E2E_MODEL_CONFIG",
            providerId: "custom",
            baseUrl: cfg.url,
            model: cfg.model,
          },
          apiKey: cfg.api_key,
          contextLength: Number(cfg.max_context_size) || 64000,
        };
      }
      throw new Error(`E2E_MODEL_CONFIG missing model/url/api_key in ${configPath}`);
    } catch (err) {
      // Surface the bad config instead of silently falling back to echo mode.
      throw new Error(
        `Failed to load E2E_MODEL_CONFIG=${configPath}: ${(err as Error).message}`,
      );
    }
  }
  for (const spec of PROVIDERS) {
    const key = process.env[spec.envVar] ?? "";
    if (key.trim()) return { spec, apiKey: key.trim() };
  }
  return null;
}

const composer = (page: Page) => page.getByRole("textbox", { name: "输入消息" });
const sendButton = (page: Page) => page.getByRole("button", { name: "发送消息" });

test.describe("Local-first chat (no backend, real LLM API)", () => {
  const resolved = resolveProvider();
  test.skip(!resolved, "No LLM config found (set E2E_MODEL_CONFIG=/path/model.json, or DEEPSEEK_API_KEY / KIMI_API_KEY)");

  test("seed config → new session → send hello → receive real reply", async ({ page }) => {
    const { spec, apiKey, contextLength } = resolved!;

    // 1. Navigate to the app. On first run (empty localStorage), a model
    //    onboarding dialog appears. Click "先看看界面" to dismiss it so we
    //    can access the page and seed the config.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "开始使用 Hermes" });
    // Wait for the onboarding dialog to appear (first run in fresh browser)
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "先看看界面" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    // The composer may take a moment to render after the dialog closes.
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });

    // 2. Seed the local config + env store directly into the UI store.
    //    In standalone web mode, the UI store backs to localStorage under
    //    the key "hermes_ui_backup" (see ui-store.ts). Writing there before
    //    any fetch bypasses the Vite proxy entirely — the local dashboard
    //    handlers read from the in-memory cache that initUiStore populates
    //    from this same localStorage key on next page load.
    await page.evaluate(({ spec, apiKey, contextLength }) => {
      const STORE_KEY = "hermes_ui_backup";
      const backup = localStorage.getItem(STORE_KEY);
      const store = backup ? JSON.parse(backup) : {};

      // Seed the model config (matches the shape buildCurrentModelConfigUpdate writes)
      store["hermes.active-config"] = {
        ...(typeof store["hermes.active-config"] === "object" && store["hermes.active-config"] !== null
          ? store["hermes.active-config"]
          : {}),
        model: {
          provider: spec.providerId,
          default: spec.model,
          base_url: spec.baseUrl,
          api_mode: "chat_completions",
          api_key: apiKey,
        },
    model_context_length: contextLength,
  };

      // Seed the env vars store (matches the shape localEnvPutHandler writes)
      const envVars =
        typeof store["hermes.env-vars"] === "object" && store["hermes.env-vars"] !== null
          ? store["hermes.env-vars"]
          : {};
      envVars[spec.envVar] = apiKey;
      store["hermes.env-vars"] = envVars;

      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    }, { spec, apiKey, contextLength });

    // 3. Reload so that React hooks (useModelInfo, useConfig, useEnvVars)
    //    re-fetch from the local store and the UI reflects the seeded config.
    //    With a model now configured, the onboarding dialog should not appear.
    await page.reload();
    // Dismiss onboarding again if it shows (shouldn't with config seeded, but
    // be defensive in case localStorage timing differs).
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "先看看界面" }).click();
    }
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });

    // 4. Send a message. The in-process gateway transport dispatches
    //    prompt.submit → streamLocalTurn → resolveLocalModelConfig →
    //    callRemoteModel(real API).
    await composer(page).fill("hello");
    await sendButton(page).click();

    // 5. The app should create a session and navigate to /tasks/:id.
    await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });

    // 6. Wait for the assistant reply to appear and have real text content.
    const lastAssistant = () =>
      page.getByRole("log").locator('[data-role="assistant"]').last();

    await expect(lastAssistant()).toBeVisible({ timeout: 30_000 });

    // Poll for non-empty text (streaming renders progressively).
    await expect
      .poll(async () => {
        const text = (await lastAssistant().innerText()).trim();
        return text.length;
      }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
      .toBeGreaterThan(0);

    const replyText = (await lastAssistant().innerText()).trim();

    // 7. Assert the reply is a REAL model response, not the echo fallback.
    //    The echo mode prefix is "[本地引擎·回声模式]" — if we see it,
    //    local-agent failed to resolve the model config and fell back.
    expect(
      replyText,
      "Reply should not be the echo-mode fallback — the real LLM API was not called. " +
        "Check that the config/env were seeded correctly.",
    ).not.toContain("本地引擎");

    expect(replyText, "Reply should not be empty").not.toHaveLength(0);

    // 8. Verify the session persists: navigate home and back.
    await page.goto("/");
    await expect(composer(page)).toBeVisible({ timeout: 10_000 });
  });
});
