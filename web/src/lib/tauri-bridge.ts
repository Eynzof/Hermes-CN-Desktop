// Tauri v2 IPC bridge.
//
// Wraps @tauri-apps/api/core::invoke() calls to match the hermesDesktop API
// surface. On initialization, populates window.hermesDesktop so that ALL
// existing call sites (settings.tsx, projects.tsx, goose-composer.tsx, etc.)
// work without any changes.

import type {
  ApiRequestInput,
  ApiRequestResult,
  ConfigMigrationImportInput,
  ConfigMigrationImportResult,
  ConfigMigrationScanInput,
  ConfigMigrationScanResult,
  FilePickerResult,
  FileUploadInput,
  ImOnboardingApplyInput,
  ImOnboardingApplyResult,
  ImOnboardingBeginInput,
  ImOnboardingBeginResult,
  ImOnboardingPollInput,
  ImOnboardingPollResult,
  ImOnboardingStateInput,
  ImOnboardingStateResult,
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
  SetYoloModeInput,
  SetYoloModeResult,
  SwitchProfileInput,
  SwitchProfileResult,
  YoloModeStatus,
} from "@hermes/protocol";
import type {
  SkillMarkdownResult,
  TerminalEventPayload,
  TerminalStartInput,
  TerminalStartResult,
  UiEventInput,
  UiStoreSnapshot,
  UiTurnStats,
} from "./runtime";
import hermesLogoSvg from "../../../icons/icon.svg?raw";

let invoke: typeof import("@tauri-apps/api/core").invoke;

export function isTauriDevMode(envDev = import.meta.env.DEV): boolean {
  return envDev;
}

const BASE64_CHUNK_SIZE = 0x8000;

export function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)));
  }

  return btoa(chunks.join(""));
}

async function ensureInvoke() {
  if (!invoke) {
    const mod = await import("@tauri-apps/api/core");
    invoke = mod.invoke;
  }
  return invoke;
}

const tauriBridge = {
  windowType: "tauri" as const,

  async request(input: ApiRequestInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("api_request", { input });
  },

  async externalRequest(input: ApiRequestInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("external_request", { input });
  },

  async uploadFile(input: FileUploadInput): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    const base64 = arrayBufferToBase64(input.data);
    return inv("upload_file", {
      input: {
        sessionId: input.sessionId,
        name: input.name,
        type: input.type,
        data: base64,
      },
    });
  },

  async pickFiles(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("pick_files");
  },

  async pickDirectory(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("pick_directory");
  },

  async createWorkspaceProject(): Promise<FilePickerResult> {
    const inv = await ensureInvoke();
    return inv("create_workspace_project");
  },

  async openWorkspacePath(input: { path: string }): Promise<ApiRequestResult> {
    const inv = await ensureInvoke();
    return inv("open_workspace_path", { input });
  },

  getRuntimeConfig() {
    return window.__HERMES_RUNTIME__;
  },

  async refreshGatewayUrl(): Promise<{ gatewayUrl: string; sessionToken?: string }> {
    const inv = await ensureInvoke();
    return inv("refresh_gateway_url");
  },

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    const inv = await ensureInvoke();
    return inv("runtime_info");
  },

  async checkRuntimeUpdate(): Promise<RuntimeUpdateCheckResult> {
    const inv = await ensureInvoke();
    return inv("runtime_check_update");
  },

  async installRuntimeUpdate(): Promise<RuntimeInstallUpdateResult> {
    const inv = await ensureInvoke();
    return inv("runtime_install_update");
  },

  async rollbackRuntime(): Promise<RuntimeInstallUpdateResult> {
    const inv = await ensureInvoke();
    return inv("runtime_rollback");
  },

  async switchProfile(input: SwitchProfileInput): Promise<SwitchProfileResult> {
    const inv = await ensureInvoke();
    return inv("switch_profile", { input });
  },


  async scanConfigMigration(input?: ConfigMigrationScanInput): Promise<ConfigMigrationScanResult> {
    const inv = await ensureInvoke();
    return inv("config_migration_scan", { input: input ?? null });
  },

  async importConfigMigration(input: ConfigMigrationImportInput): Promise<ConfigMigrationImportResult> {
    const inv = await ensureInvoke();
    return inv("config_migration_import", { input });
  },

  async getYoloMode(): Promise<YoloModeStatus> {
    const inv = await ensureInvoke();
    return inv("get_yolo_mode");
  },

  async setYoloMode(input: SetYoloModeInput): Promise<SetYoloModeResult> {
    const inv = await ensureInvoke();
    return inv("set_yolo_mode", { input });
  },

  async imOnboardingState(input: ImOnboardingStateInput): Promise<ImOnboardingStateResult> {
    const inv = await ensureInvoke();
    return inv("im_onboarding_state", { input });
  },

  async imOnboardingBegin(input: ImOnboardingBeginInput): Promise<ImOnboardingBeginResult> {
    const inv = await ensureInvoke();
    return inv("im_onboarding_begin", { input });
  },

  async imOnboardingPoll(input: ImOnboardingPollInput): Promise<ImOnboardingPollResult> {
    const inv = await ensureInvoke();
    return inv("im_onboarding_poll", { input });
  },

  async imOnboardingApply(input: ImOnboardingApplyInput): Promise<ImOnboardingApplyResult> {
    const inv = await ensureInvoke();
    return inv("im_onboarding_apply", { input });
  },

  async readSkillMarkdown(input: { name: string }): Promise<SkillMarkdownResult> {
    const inv = await ensureInvoke();
    return inv("read_skill_markdown", { input });
  },

  async readMemory() {
    const inv = await ensureInvoke();
    return inv("read_memory");
  },

  async addMemoryEntry(content: string) {
    const inv = await ensureInvoke();
    return inv("add_memory_entry", { content });
  },

  async updateMemoryEntry(index: number, content: string) {
    const inv = await ensureInvoke();
    return inv("update_memory_entry", { index, content });
  },

  async removeMemoryEntry(index: number) {
    const inv = await ensureInvoke();
    return inv("remove_memory_entry", { index });
  },

  async writeUserProfile(content: string) {
    const inv = await ensureInvoke();
    return inv("write_user_profile", { content });
  },

  async uiStoreSnapshot(): Promise<UiStoreSnapshot> {
    const inv = await ensureInvoke();
    return inv("ui_store_snapshot");
  },

  async uiStoreSetKv(input: { key: string; value: unknown }): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("ui_store_set_kv", { input });
  },

  async uiStoreRemoveKv(input: { key: string }): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("ui_store_remove_kv", { input });
  },

  async uiStoreRecordTurnStats(input: UiTurnStats): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("ui_store_record_turn_stats", { input });
  },

  async uiStoreGetTurnStats(input: { sessionId: string }): Promise<UiTurnStats[]> {
    const inv = await ensureInvoke();
    return inv("ui_store_get_turn_stats", { input });
  },

  async uiStoreRecordEvent(input: UiEventInput): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("ui_store_record_event", { input });
  },

  async terminalStart(input: TerminalStartInput): Promise<TerminalStartResult> {
    const inv = await ensureInvoke();
    return inv("terminal_start", { input });
  },

  async terminalWrite(input: { terminalId: string; data: string }): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("terminal_write", { input });
  },

  async terminalResize(input: { terminalId: string; cols: number; rows: number }): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("terminal_resize", { input });
  },

  async terminalClose(input: { terminalId: string }): Promise<boolean> {
    const inv = await ensureInvoke();
    return inv("terminal_close", { input });
  },

  onTerminalOutput(handler: (event: TerminalEventPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<TerminalEventPayload>("terminal-output", (event) => {
        handler(event.payload);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      unlisten?.();
    };
  },

  onSystemResume(handler: () => void): () => void {
    // Initial build: rely on the JS clock-skew watchdog in gateway-client.ts.
    // The watchdog detects sleep/wake within ~5s, which is acceptable.
    // Native power monitoring can be added later via a Tauri event.
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("system-resume", handler).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      unlisten?.();
    };
  },
};

// Overlay shown while the Rust side downloads the managed runtime on
// first launch. Pre-React, plain DOM — we can't mount React yet
// because the bridge isn't ready (no apiBaseUrl => API calls would
// throw). Phase strings match the `runtime-status` event emitted by
// src/main.rs::emit_runtime_status.
function showBootstrapOverlay(initialMessage: string): {
  update(phase: string, message: string): void;
  dismiss(): void;
} {
  let lastErrorMessage = "";

  const root = document.createElement("div");
  root.id = "hermes-bootstrap-overlay";
  root.setAttribute(
    "style",
    "position:fixed;inset:0;background:" +
      "radial-gradient(circle at 50% 40%,rgba(201,107,58,0.30) 0%,rgba(201,107,58,0.18) 22%,rgba(201,107,58,0.08) 42%,transparent 62%),#0a0a0a;" +
      "color:#fbfaf6;display:flex;align-items:center;justify-content:center;" +
      "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "z-index:2147483647;padding:48px;box-sizing:border-box;overflow:auto;",
  );

  const panel = document.createElement("section");
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute(
    "style",
    "width:min(760px,calc(100vw - 64px));display:flex;flex-direction:column;" +
      "align-items:center;gap:18px;text-align:center;",
  );

  const mark = document.createElement("img");
  mark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(hermesLogoSvg)}`;
  mark.alt = "Hermes Agent Logo";
  mark.setAttribute(
    "style",
    "width:104px;height:104px;border-radius:24px;display:block;" +
      "box-shadow:0 24px 60px rgba(0,0,0,0.45),0 0 80px rgba(201,107,58,0.42),0 0 0 1px rgba(255,255,255,0.08);",
  );
  panel.appendChild(mark);

  const title = document.createElement("div");
  title.setAttribute(
    "style",
    "font-size:16px;font-weight:700;letter-spacing:0.02em;color:#fbfaf6;",
  );
  title.textContent = "Hermes Agent 中文社区桌面版";
  panel.appendChild(title);

  const message = document.createElement("div");
  message.id = "hermes-bootstrap-message";
  message.setAttribute(
    "style",
    "font-size:15px;color:rgba(251,250,246,0.9);max-width:620px;line-height:1.6;",
  );
  message.textContent = initialMessage;
  panel.appendChild(message);

  const detail = document.createElement("div");
  detail.id = "hermes-bootstrap-error-detail";
  detail.setAttribute(
    "style",
    "display:none;width:100%;box-sizing:border-box;margin-top:4px;border:1px solid rgba(251,250,246,0.14);" +
      "border-radius:18px;background:rgba(18,18,18,0.86);box-shadow:0 18px 48px rgba(0,0,0,0.28);overflow:hidden;",
  );

  const detailHeader = document.createElement("div");
  detailHeader.setAttribute(
    "style",
    "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;" +
      "border-bottom:1px solid rgba(251,250,246,0.1);",
  );

  const detailTitle = document.createElement("div");
  detailTitle.setAttribute(
    "style",
    "font-size:12px;font-weight:700;color:rgba(251,250,246,0.72);letter-spacing:0.08em;text-transform:uppercase;",
  );
  detailTitle.textContent = "完整错误信息";
  detailHeader.appendChild(detailTitle);

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.disabled = true;
  copyButton.setAttribute(
    "style",
    "appearance:none;border:1px solid rgba(251,250,246,0.18);background:rgba(251,250,246,0.08);" +
      "color:#fbfaf6;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;" +
      "font-family:inherit;cursor:pointer;",
  );
  copyButton.textContent = "复制错误信息";
  detailHeader.appendChild(copyButton);
  detail.appendChild(detailHeader);

  const errorText = document.createElement("pre");
  errorText.id = "hermes-bootstrap-error-text";
  errorText.tabIndex = 0;
  errorText.setAttribute(
    "style",
    "margin:0;max-height:min(300px,38vh);overflow:auto;padding:14px;text-align:left;" +
      "white-space:pre-wrap;word-break:break-word;user-select:text;" +
      "font-family:'JetBrains Mono','SFMono-Regular',Consolas,ui-monospace,monospace;" +
      "font-size:12px;line-height:1.6;color:rgba(251,250,246,0.88);",
  );
  detail.appendChild(errorText);
  panel.appendChild(detail);

  const sub = document.createElement("div");
  sub.id = "hermes-bootstrap-sub";
  sub.setAttribute(
    "style",
    "font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;" +
      "color:rgba(255,255,255,0.45);letter-spacing:0.06em;text-transform:uppercase;",
  );
  sub.textContent = "Hermes Agent 中文社区桌面版 · 首次启动";
  panel.appendChild(sub);

  root.appendChild(panel);

  document.body.appendChild(root);

  const copyErrorMessage = async () => {
    if (!lastErrorMessage) return;
    try {
      await navigator.clipboard.writeText(lastErrorMessage);
      copyButton.textContent = "已复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制错误信息";
      }, 1600);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(errorText);
      selection?.removeAllRanges();
      selection?.addRange(range);
      copyButton.textContent = "已选中，可手动复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制错误信息";
      }, 2200);
    }
  };

  copyButton.addEventListener("click", () => {
    void copyErrorMessage();
  });

  return {
    update(phase, msg) {
      if (phase === "error") {
        lastErrorMessage = msg || "未知启动错误";
        root.setAttribute("role", "alert");
        panel.setAttribute("aria-live", "assertive");
        message.textContent = "启动 Hermes Agent 内核时遇到问题，请复制下方完整错误信息用于排查。";
        errorText.textContent = lastErrorMessage;
        detail.style.display = "block";
        copyButton.disabled = false;
        sub.textContent = "首次启动失败";
      } else if (msg) {
        message.textContent = msg;
      }
    },
    dismiss() {
      root.remove();
    },
  };
}

async function waitForBootstrap(
  initialMessage: string,
  readConfig: () => Promise<{ apiBaseUrl?: string }>,
  readRuntimeInfo: () => Promise<{ lastError?: string }>,
): Promise<{ failed: boolean; message: string }> {
  const overlay = showBootstrapOverlay(initialMessage);
  const { listen } = await import("@tauri-apps/api/event");

  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    let interval: number | null = null;
    let settled = false;

    const finish = (result: { failed: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      if (interval !== null) window.clearInterval(interval);
      if (!result.failed) overlay.dismiss();
      resolve(result);
    };

    const checkReady = () => {
      void readConfig()
        .then((cfg) => {
          if (cfg.apiBaseUrl) finish({ failed: false, message: "" });
        })
        .catch(() => {});
      void readRuntimeInfo()
        .then((info) => {
          if (info.lastError) {
            overlay.update("error", info.lastError);
            finish({ failed: true, message: info.lastError });
          }
        })
        .catch(() => {});
    };

    listen<{ phase: string; message: string }>("runtime-status", (event) => {
      const { phase, message } = event.payload;
      overlay.update(phase, message);
      if (phase === "ready") {
        finish({ failed: false, message: "" });
      } else if (phase === "error") {
        // Leave the overlay up so the user sees the error message; the
        // process keeps running so they can read it. They'll need to
        // close + relaunch (or fix the env / hit a "retry" button we
        // add later).
        finish({ failed: true, message });
      }
    }).then((fn) => {
      unlisten = fn;
      checkReady();
      interval = window.setInterval(checkReady, 500);
    });
  });
}

export async function installTauriBridge(): Promise<void> {
  const inv = await ensureInvoke();
  let config = await inv<{
    apiBaseUrl: string;
    gatewayUrl: string;
    sessionToken?: string;
    currentProfile: string;
    transport?: string;
  }>("get_runtime_config");

  // Dev mode: WebView loads from Vite dev server (http://localhost:9545).
  // Don't set apiBaseUrl/gatewayUrl — let the browser use relative URLs that
  // go through Vite's proxy, just like web mode. This avoids cross-origin
  // issues with SSE EventSource and WebSocket (browser-native APIs that can't
  // go through the Tauri IPC bridge).
  // Production Tauri v2 can also load bundled assets from an
  // `http://*.localhost` origin on Windows, so URL protocol is not a
  // reliable dev/prod signal. Use Vite's explicit build mode instead.
  const isDevMode = isTauriDevMode();

  // First-run / managed dev: Rust spawned the install/start task and returned
  // immediately with empty state. Show the overlay and block here until the
  // `runtime-status` event reports `ready`, then refetch the config so we get
  // the populated apiBaseUrl/sessionToken. In Vite dev we still avoid writing
  // apiBaseUrl into window.__HERMES_RUNTIME__ later, but waiting here prevents
  // the React app from racing the managed dashboard startup.
  if (!config.apiBaseUrl) {
    const result = await waitForBootstrap(
      "正在启动Hermes Agent内核...",
      () => inv("get_runtime_config"),
      () => inv("runtime_info"),
    );
    if (result.failed) {
      // Leave the overlay up — the user needs to see the message
      // and decide what to do (close and reopen, fix env vars, etc).
      // Throwing here would surface in the React error boundary, but
      // we never mounted React; the overlay IS the UI right now.
      throw new Error(`runtime bootstrap failed: ${result.message}`);
    }
    config = await inv("get_runtime_config");
  }

  const transport = (config.transport === "ws" || config.transport === "sse")
    ? config.transport
    : "sse";

  window.__HERMES_RUNTIME__ = {
    platform: "tauri" as const,
    apiBaseUrl: isDevMode ? undefined : config.apiBaseUrl,
    dashboardApiBaseUrl: config.apiBaseUrl,
    gatewayUrl: isDevMode ? undefined : config.gatewayUrl,
    sessionToken: isDevMode ? undefined : config.sessionToken,
    currentProfile: config.currentProfile,
    transport,
  };

  (window as any).hermesDesktop = tauriBridge;
}
