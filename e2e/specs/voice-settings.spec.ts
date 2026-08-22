import { expect, test } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_ORIGIN,
  HERMES_HOME,
} from "../harness/config.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Voice settings page vs real Core backend schema (TTS/STT contract drift).
//
// The backend (hermes-agent-cn) declares the canonical option set for
// `stt.openai.model` in /api/config/schema:
//   ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe"]
// (also mirrored in tools/transcription_tools.py OPENAI_MODELS).
//
// The desktop's voice settings page (`web/src/lib/voice-config.ts`) ignores the
// schema it already receives and renders the field from a hardcoded list:
//   ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"]
// → `gpt-transcribe` is missing. A user whose config.yaml uses the
// backend-valid `stt.openai.model: gpt-transcribe` sees a blank dropdown and
// cannot display or re-select the active model from the settings UI.
//
// These tests drive the REAL Vite frontend against the REAL Core dashboard and
// assert the backend schema (source of truth) vs what the page actually
// renders. They fail on the current desktop code — that failure IS the trigger
// proving the mismatch.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = resolve(HERMES_HOME, "config.yaml");

test.describe("语音设置页 vs 后端 schema", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeAll(async () => {
    // Real backend reads config.yaml per request, so we can point the active
    // STT provider at a backend-valid model the desktop dropdown omits.
    appendFileSync(
      CONFIG_PATH,
      [
        "",
        "# ---- voice drift e2e (written by voice-settings.spec.ts) ----",
        "stt:",
        "  provider: openai",
        "  openai:",
        "    model: gpt-transcribe",
        "tts:",
        "  provider: openai",
        "  openai:",
        "    voice: nova",
        "",
      ].join("\n"),
    );
  });

  test("backend schema 声明 gpt-transcribe（对照组：schema 是事实来源）", async ({ request }) => {
    const schemaRes = await request.get(`${DASHBOARD_ORIGIN}/api/config/schema`);
    expect(schemaRes.ok()).toBeTruthy();
    const schema = await schemaRes.json();
    const options = schema.fields["stt.openai.model"].options as string[];
    expect(options).toContain("gpt-transcribe");
  });

  test("语音设置页渲染后端声明的 stt.openai.model 选项（含 gpt-transcribe）", async ({ page }) => {
    await page.goto("/voice");

    // Page shell + settings cards rendered from real backend data.
    await expect(page.getByRole("heading", { name: "语音模型配置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "语音识别 STT" })).toBeVisible();

    // OpenAI Whisper is the configured provider and must show its model field.
    const openaiCard = page.locator("button", { hasText: "OpenAI Whisper" });
    await expect(openaiCard).toBeVisible();

    const modelSelect = page.locator('select[id="voice-field-stt.openai.model"]');
    await expect(modelSelect).toBeVisible();

    // The backend-declared option MUST be selectable in the desktop UI.
    await expect(
      modelSelect.locator('option[value="gpt-transcribe"]'),
    ).toHaveCount(1);
  });

  test("语音设置页显示当前配置的 gpt-transcribe 而不是空白", async ({ page }) => {
    await page.goto("/voice");

    await expect(page.getByRole("heading", { name: "语音模型配置" })).toBeVisible();

    const modelSelect = page.locator('select[id="voice-field-stt.openai.model"]');
    await expect(modelSelect).toBeVisible();

    // config.yaml says stt.openai.model: gpt-transcribe — the select must show
    // that value instead of rendering blank because the option is missing.
    await expect.poll(() => modelSelect.inputValue()).toBe("gpt-transcribe");
  });
});
