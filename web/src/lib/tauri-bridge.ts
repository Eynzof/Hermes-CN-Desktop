// Tauri v2 IPC bridge.
//
// Wraps @tauri-apps/api/core::invoke() calls to match the hermesDesktop API
// surface. On initialization, populates window.hermesDesktop so that ALL
// existing call sites (settings.tsx, projects.tsx, goose-composer.tsx, etc.)
// work without any changes.

import type {
  ApiRequestInput,
  ApiRequestResult,
  ApplyConnectionResult,
  BackupExportResult,
  BackupImportResult,
  ConfigMigrationImportInput,
  ConfigMigrationImportResult,
  ConfigMigrationScanInput,
  ConfigMigrationScanResult,
  ConnectionConfigInput,
  ConnectionConfigView,
  DesktopUpdateManifestFetchResult,
  EnvironmentCheckResult,
  ExportLogSnapshotInput,
  ExportLogSnapshotResult,
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
  ProbeConnectionResult,
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
  SetYoloModeInput,
  SetYoloModeResult,
  SwitchProfileInput,
  SwitchProfileResult,
  TestConnectionResult,
  YoloModeStatus,
} from "@hermes/protocol";
import type {
  DesktopNotifyInput,
  DesktopNotifyResult,
  DesktopFileDropPayload,
  FilePreview,
  PreviewFileChangedPayload,
  ReadWorkspaceFileInput,
  SkillMarkdownResult,
  ExportDebugBundleInput,
  ExportDebugBundleResult,
  ExternalTerminalResult,
  TerminalEventPayload,
  TerminalOpenExternalInput,
  TerminalStartInput,
  TerminalStartResult,
  UiEventInput,
  UiStoreSnapshot,
  UiTurnStats,
  WatchPreviewFileResult,
} from "./runtime";
import { BUILD_COMMIT, DESKTOP_VERSION, versionLabel } from "./build-info";
import hermesLogoSvg from "../../../icons/icon.svg?raw";

let invoke: typeof import("@tauri-apps/api/core").invoke;

export function isTauriDevMode(envDev = import.meta.env.DEV): boolean {
  return envDev;
}

const BASE64_CHUNK_SIZE = 0x8000;
const BOOTSTRAP_LOGO_BLUE_RGB = "0,95,249";

type TauriFileDropPosition = {
  x: number;
  y: number;
};

type TauriFileDropEventPayload =
  | { type: "enter"; paths?: string[]; position?: TauriFileDropPosition }
  | { type: "over"; position?: TauriFileDropPosition }
  | { type: "drop"; paths?: string[]; position?: TauriFileDropPosition }
  | { type: "leave" };

interface BootstrapVersionLine {
  label: "界面";
  version: string;
  commit: string;
}

function shortBootstrapCommit(commit: string | undefined): string {
  const normalized = commit?.trim() ?? "";
  if (!normalized || normalized === "unknown") return "—";
  return normalized.slice(0, 4);
}

function buildBootstrapVersionLine(): BootstrapVersionLine {
  return {
    label: "界面",
    version: versionLabel(DESKTOP_VERSION),
    commit: shortBootstrapCommit(BUILD_COMMIT),
  };
}

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

export interface TauriIpcError extends Error {
  code?: string;
  kind?: string;
  details?: unknown;
  raw?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeTauriInvokeError(error: unknown): Error {
  if (error instanceof Error) return error;

  if (isRecord(error)) {
    const message = typeof error.message === "string" && error.message.trim()
      ? error.message
      : JSON.stringify(error);
    const normalized = new Error(message) as TauriIpcError;
    if (typeof error.code === "string") normalized.code = error.code;
    if (typeof error.kind === "string") normalized.kind = error.kind;
    if ("details" in error) normalized.details = error.details;
    normalized.raw = error;
    return normalized;
  }

  return new Error(String(error));
}

async function invokeCommand<T = any>(command: string, args?: Record<string, unknown>): Promise<T> {
  const inv = await ensureInvoke();
  try {
    return await inv<T>(command, args);
  } catch (error) {
    throw normalizeTauriInvokeError(error);
  }
}

function normalizeFileDropPayload(payload: TauriFileDropEventPayload): DesktopFileDropPayload {
  return {
    phase: payload.type,
    paths: "paths" in payload && Array.isArray(payload.paths) ? payload.paths : [],
    position: "position" in payload && payload.position
      ? { x: payload.position.x, y: payload.position.y }
      : undefined,
  };
}

const tauriBridge = {
  windowType: "tauri" as const,

  async request(input: ApiRequestInput): Promise<ApiRequestResult> {
    return invokeCommand("api_request", { input });
  },

  async externalRequest(input: ApiRequestInput): Promise<ApiRequestResult> {
    return invokeCommand("external_request", { input });
  },

  async uploadFile(input: FileUploadInput): Promise<ApiRequestResult> {
    const base64 = arrayBufferToBase64(input.data);
    return invokeCommand("upload_file", {
      input: {
        sessionId: input.sessionId,
        name: input.name,
        type: input.type,
        data: base64,
      },
    });
  },

  async pickFiles(): Promise<FilePickerResult> {
    return invokeCommand("pick_files");
  },

  async pickDirectory(): Promise<FilePickerResult> {
    return invokeCommand("pick_directory");
  },

  async createWorkspaceProject(): Promise<FilePickerResult> {
    return invokeCommand("create_workspace_project");
  },

  onFileDrop(handler: (payload: DesktopFileDropPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          handler(normalizeFileDropPayload(event.payload as TauriFileDropEventPayload));
        }))
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        console.warn("Failed to register Tauri file drop handler", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  },

  async openWorkspacePath(input: { path: string }): Promise<ApiRequestResult> {
    return invokeCommand("open_workspace_path", { input });
  },

  async openExternalUrl(input: { url: string }): Promise<{ ok: boolean; message?: string | null }> {
    return invokeCommand("open_external_url", { input });
  },

  async exportLogSnapshot(input: ExportLogSnapshotInput): Promise<ExportLogSnapshotResult> {
    return invokeCommand("export_log_snapshot", { input });
  },

  async exportDebugBundle(input?: ExportDebugBundleInput): Promise<ExportDebugBundleResult> {
    const inv = await ensureInvoke();
    return inv("export_debug_bundle", { input: input ?? null });
  },

  async environmentCheck(): Promise<EnvironmentCheckResult> {
    return invokeCommand("environment_check");
  },

  async checkDesktopUpdate(): Promise<DesktopUpdateManifestFetchResult> {
    return invokeCommand("desktop_check_update");
  },

  getRuntimeConfig() {
    return window.__HERMES_RUNTIME__;
  },

  async refreshGatewayUrl(): Promise<{ gatewayUrl: string; sessionToken?: string }> {
    return invokeCommand("refresh_gateway_url");
  },

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return invokeCommand("runtime_info");
  },

  async checkRuntimeUpdate(): Promise<RuntimeUpdateCheckResult> {
    return invokeCommand("runtime_check_update");
  },

  async installRuntimeUpdate(): Promise<RuntimeInstallUpdateResult> {
    return invokeCommand("runtime_install_update");
  },

  async rollbackRuntime(): Promise<RuntimeInstallUpdateResult> {
    return invokeCommand("runtime_rollback");
  },

  async exportProfileBackup(): Promise<BackupExportResult> {
    const inv = await ensureInvoke();
    return inv("backup_export_profile");
  },

  async importProfileBackup(): Promise<BackupImportResult> {
    const inv = await ensureInvoke();
    return inv("backup_import_profile");
  },

  async switchProfile(input: SwitchProfileInput): Promise<SwitchProfileResult> {
    return invokeCommand("switch_profile", { input });
  },

  async getConnectionConfig(): Promise<ConnectionConfigView> {
    return invokeCommand("get_connection_config");
  },

  async saveConnectionConfig(input: ConnectionConfigInput): Promise<ConnectionConfigView> {
    return invokeCommand("save_connection_config", { input });
  },

  async applyConnectionConfig(input: ConnectionConfigInput): Promise<ApplyConnectionResult> {
    return invokeCommand("apply_connection_config", { input });
  },

  async testConnectionConfig(input: ConnectionConfigInput): Promise<TestConnectionResult> {
    return invokeCommand("test_connection_config", { input });
  },

  async probeConnectionConfig(remoteUrl: string): Promise<ProbeConnectionResult> {
    return invokeCommand("probe_connection_config", { remoteUrl });
  },


  async scanConfigMigration(input?: ConfigMigrationScanInput): Promise<ConfigMigrationScanResult> {
    return invokeCommand("config_migration_scan", { input: input ?? null });
  },

  async importConfigMigration(input: ConfigMigrationImportInput): Promise<ConfigMigrationImportResult> {
    return invokeCommand("config_migration_import", { input });
  },

  async getYoloMode(): Promise<YoloModeStatus> {
    return invokeCommand("get_yolo_mode");
  },

  async setYoloMode(input: SetYoloModeInput): Promise<SetYoloModeResult> {
    return invokeCommand("set_yolo_mode", { input });
  },

  async imOnboardingState(input: ImOnboardingStateInput): Promise<ImOnboardingStateResult> {
    return invokeCommand("im_onboarding_state", { input });
  },

  async imOnboardingBegin(input: ImOnboardingBeginInput): Promise<ImOnboardingBeginResult> {
    return invokeCommand("im_onboarding_begin", { input });
  },

  async imOnboardingPoll(input: ImOnboardingPollInput): Promise<ImOnboardingPollResult> {
    return invokeCommand("im_onboarding_poll", { input });
  },

  async imOnboardingApply(input: ImOnboardingApplyInput): Promise<ImOnboardingApplyResult> {
    return invokeCommand("im_onboarding_apply", { input });
  },

  async readSkillMarkdown(input: { name: string }): Promise<SkillMarkdownResult> {
    return invokeCommand("read_skill_markdown", { input });
  },

  async readMemory() {
    return invokeCommand("read_memory");
  },

  async addMemoryEntry(content: string) {
    return invokeCommand("add_memory_entry", { content });
  },

  async updateMemoryEntry(index: number, content: string) {
    return invokeCommand("update_memory_entry", { index, content });
  },

  async removeMemoryEntry(index: number) {
    return invokeCommand("remove_memory_entry", { index });
  },

  async writeUserProfile(content: string) {
    return invokeCommand("write_user_profile", { content });
  },

  async uiStoreSnapshot(): Promise<UiStoreSnapshot> {
    return invokeCommand("ui_store_snapshot");
  },

  async uiStoreSetKv(input: { key: string; value: unknown }): Promise<boolean> {
    return invokeCommand("ui_store_set_kv", { input });
  },

  async uiStoreRemoveKv(input: { key: string }): Promise<boolean> {
    return invokeCommand("ui_store_remove_kv", { input });
  },

  async uiStoreRecordTurnStats(input: UiTurnStats): Promise<boolean> {
    return invokeCommand("ui_store_record_turn_stats", { input });
  },

  async uiStoreGetTurnStats(input: { sessionId: string }): Promise<UiTurnStats[]> {
    return invokeCommand("ui_store_get_turn_stats", { input });
  },

  async uiStoreGetTurnStatsWindow(input: { sinceMs?: number; limit?: number }): Promise<UiTurnStats[]> {
    return invokeCommand("ui_store_get_turn_stats_window", { input });
  },

  async uiStoreRecordEvent(input: UiEventInput): Promise<boolean> {
    return invokeCommand("ui_store_record_event", { input });
  },

  async desktopNotify(input: DesktopNotifyInput): Promise<DesktopNotifyResult> {
    return invokeCommand("desktop_notify", { input });
  },

  async terminalStart(input: TerminalStartInput): Promise<TerminalStartResult> {
    return invokeCommand("terminal_start", { input });
  },

  async terminalOpenExternal(input: TerminalOpenExternalInput): Promise<ExternalTerminalResult> {
    return invokeCommand("terminal_open_external", { input });
  },

  async terminalWrite(input: { terminalId: string; data: string }): Promise<boolean> {
    return invokeCommand("terminal_write", { input });
  },

  async terminalResize(input: { terminalId: string; cols: number; rows: number }): Promise<boolean> {
    return invokeCommand("terminal_resize", { input });
  },

  async terminalClose(input: { terminalId: string }): Promise<boolean> {
    return invokeCommand("terminal_close", { input });
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

  async readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<FilePreview> {
    return invokeCommand("read_workspace_file", { input });
  },

  async watchPreviewFile(input: { path: string }): Promise<WatchPreviewFileResult> {
    return invokeCommand("watch_preview_file", { input });
  },

  async stopPreviewFileWatch(input: { watchId: string }): Promise<boolean> {
    return invokeCommand("stop_preview_file_watch", { input });
  },

  onPreviewFileChanged(handler: (payload: PreviewFileChangedPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<PreviewFileChangedPayload>("preview-file-changed", (event) => {
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
      `radial-gradient(circle at 50% 40%,rgba(${BOOTSTRAP_LOGO_BLUE_RGB},0.30) 0%,rgba(${BOOTSTRAP_LOGO_BLUE_RGB},0.18) 22%,rgba(${BOOTSTRAP_LOGO_BLUE_RGB},0.08) 42%,transparent 62%),#0a0a0a;` +
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
      `box-shadow:0 24px 60px rgba(0,0,0,0.45),0 0 80px rgba(${BOOTSTRAP_LOGO_BLUE_RGB},0.42),0 0 0 1px rgba(255,255,255,0.08);`,
  );
  panel.appendChild(mark);

  const title = document.createElement("div");
  title.setAttribute(
    "style",
    "font-size:16px;font-weight:700;letter-spacing:0.02em;color:#fbfaf6;",
  );
  title.textContent = "Hermes Agent 中文社区桌面版";
  panel.appendChild(title);

  const brand = document.createElement("div");
  brand.setAttribute(
    "style",
    "margin-top:-10px;font-size:12px;font-weight:600;color:rgba(251,250,246,0.54);" +
      "letter-spacing:0.08em;text-transform:uppercase;",
  );
  brand.textContent = "Hermes Agent 中文社区 · hermesagent.org.cn";
  panel.appendChild(brand);

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

  const versionPanel = document.createElement("div");
  versionPanel.setAttribute(
    "style",
    "display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:2px;" +
      "font-family:'JetBrains Mono','SFMono-Regular',Consolas,ui-monospace,monospace;" +
      "font-size:10px;line-height:1.45;letter-spacing:0.06em;color:rgba(133,126,111,0.76);",
  );

  const uiVersionRow = document.createElement("div");

  const applyVersionRow = (rowEl: HTMLDivElement, line: BootstrapVersionLine) => {
    rowEl.setAttribute(
      "style",
      "font-variant-numeric:tabular-nums;white-space:nowrap;color:rgba(133,126,111,0.76);",
    );
    rowEl.textContent = `${line.label} ${line.version} · ${line.commit}`;
  };

  applyVersionRow(uiVersionRow, buildBootstrapVersionLine());
  versionPanel.append(uiVersionRow);
  panel.appendChild(versionPanel);

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
  const { listen } = await import("@tauri-apps/api/event");

  return new Promise((resolve) => {
    let overlay: ReturnType<typeof showBootstrapOverlay> | null = null;
    let unlisten: (() => void) | null = null;
    let interval: number | null = null;
    let showTimer: number | null = null;
    let settled = false;
    let lastPhase = "starting";
    let lastMessage = initialMessage;

    const ensureOverlay = () => {
      if (!overlay) {
        overlay = showBootstrapOverlay(lastMessage || initialMessage);
        overlay.update(lastPhase, lastMessage || initialMessage);
      }
      return overlay;
    };

    showTimer = window.setTimeout(() => {
      if (!settled) ensureOverlay();
    }, 1200);

    const finish = (result: { failed: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      if (interval !== null) window.clearInterval(interval);
      if (showTimer !== null) window.clearTimeout(showTimer);
      if (!result.failed) overlay?.dismiss();
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
            lastPhase = "error";
            lastMessage = info.lastError;
            ensureOverlay().update("error", info.lastError);
            finish({ failed: true, message: info.lastError });
          }
        })
        .catch(() => {});
    };

    listen<{ phase: string; message: string }>("runtime-status", (event) => {
      const { phase, message } = event.payload;
      lastPhase = phase;
      if (message) lastMessage = message;
      overlay?.update(phase, message);
      if (phase === "ready") {
        finish({ failed: false, message: "" });
      } else if (phase === "error") {
        // Error paths should be visible immediately even if the normal slow-start
        // threshold has not elapsed yet.
        ensureOverlay().update("error", message);
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
  let config = await invokeCommand<{
    apiBaseUrl: string;
    gatewayUrl: string;
    sessionToken?: string;
    currentProfile: string;
    connectionMode?: "local" | "remote";
  }>("get_runtime_config");

  // Dev mode: WebView loads from Vite dev server (http://localhost:9545).
  // Don't set apiBaseUrl/gatewayUrl — let the browser use relative URLs that
  // go through Vite's proxy, just like web mode. This avoids cross-origin
  // issues with the gateway WebSocket (a browser-native API that can't
  // go through the Tauri IPC bridge). Still inject sessionToken in dev: managed
  // runtime builds may not have dashboard web_dist, so Vite cannot reliably
  // scrape the token from Dashboard /; authenticated REST calls still need the
  // token header while using the relative proxy URL.
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
      () => invokeCommand("get_runtime_config"),
      () => invokeCommand("runtime_info"),
    );
    if (result.failed) {
      // Leave the overlay up — the user needs to see the message
      // and decide what to do (close and reopen, fix env vars, etc).
      // Throwing here would surface in the React error boundary, but
      // we never mounted React; the overlay IS the UI right now.
      throw new Error(`runtime bootstrap failed: ${result.message}`);
    }
    config = await invokeCommand("get_runtime_config");
  }

  // Remote mode must keep the real URLs even in Vite dev: the Vite proxy
  // targets the LOCAL dashboard port, so relative URLs would route remote
  // traffic to a backend that isn't connected. With apiBaseUrl set, transport
  // goes through the Rust proxy and the gateway socket through the Rust relay,
  // exactly like production.
  const isRemote = config.connectionMode === "remote";
  const hideUrlsForViteProxy = isDevMode && !isRemote;

  window.__HERMES_RUNTIME__ = {
    platform: "tauri" as const,
    apiBaseUrl: hideUrlsForViteProxy ? undefined : config.apiBaseUrl,
    dashboardApiBaseUrl: config.apiBaseUrl,
    gatewayUrl: hideUrlsForViteProxy ? undefined : config.gatewayUrl,
    sessionToken: config.sessionToken,
    currentProfile: config.currentProfile,
    connectionMode: config.connectionMode ?? "local",
  };

  (window as any).hermesDesktop = tauriBridge;
}
