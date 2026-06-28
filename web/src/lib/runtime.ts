import type {
  ApplyConnectionResult,
  BackupExportResult,
  BackupImportResult,
  ConfigMigrationImportInput,
  ConfigMigrationImportResult,
  ConfigMigrationScanInput,
  ConfigMigrationScanResult,
  ConnectionConfigInput,
  ConnectionConfigView,
  ConnectionMode,
  DesktopUpdateManifestFetchResult,
  EnvironmentCheckResult,
  ExportLogSnapshotInput,
  ExportLogSnapshotResult,
  FileUploadInput,
  HermesMessageMetadata,
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

export type RuntimePlatform = "web" | "electron" | "tauri";
export type HostOS = "macos" | "windows" | "linux" | "unknown";

export interface ElectronApiRequestInput {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface ElectronApiRequestResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface ElectronFilePickerResult {
  canceled: boolean;
  paths: string[];
}

export interface DownloadExternalImageInput {
  url: string;
}

export interface DownloadedImageResult {
  finalUrl: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  size: number;
}

export interface ElectronSimpleResult {
  ok: boolean;
  message?: string | null;
}

export interface MemoryEntry {
  index: number;
  content: string;
}

export interface MemoryInfo {
  memory: {
    content: string;
    exists: boolean;
    lastModified: number | null;
    entries: MemoryEntry[];
    charCount: number;
    charLimit: number;
  };
  user: {
    content: string;
    exists: boolean;
    lastModified: number | null;
    charCount: number;
    charLimit: number;
  };
  stats: { totalSessions: number; totalMessages: number };
}

export interface MemoryMutationResult {
  success: boolean;
  error?: string | null;
}

export interface SkillMarkdownResult {
  name: string;
  path: string;
  content: string;
  sizeBytes: number;
}

export interface UiStoreSnapshot {
  kv: Record<string, unknown>;
}

export interface UiTurnStats {
  id: string;
  sessionId: string;
  gatewaySessionId?: string;
  clientMessageId?: string;
  backendMessageId?: number;
  turnIndex?: number;
  contentHash?: string;
  metadata?: HermesMessageMetadata;
  model?: string;
  provider?: string;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  ttftMs?: number;
  durationMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  apiCalls?: number;
  costUsd?: number;
  costStatus?: string;
  finishReason?: string;
  status?: string;
  createdAt?: number;
}

export interface UiEventInput {
  id: string;
  ts: number;
  eventName: string;
  sessionId?: string;
  source?: string;
  props?: Record<string, unknown>;
  appVersion?: string;
}

export interface ExportDebugBundleInput {
  frontendDebug?: unknown;
  rendererDiagnostics?: Record<string, unknown>;
}

export interface ExportDebugBundleResult {
  ok: boolean;
  zipPath: string;
  directoryPath: string;
  sizeBytes: number;
  includedFiles: number;
  warnings: string[];
}

export interface DesktopNotifyInput {
  kind: "approval" | "complete" | "error" | "test";
  title: string;
  body: string;
  /** 设置「系统通知」开关；false 时仅做焦点判定与注意力请求。 */
  showSystemNotification: boolean;
  /** 系统通知自带的原生提示音。 */
  withSound: boolean;
  /** 「仅窗口在后台时通知」；测试按钮传 false。 */
  respectFocus: boolean;
  requestAttention: boolean;
}

export interface DesktopNotifyResult {
  /** 系统通知已实际发出。 */
  delivered: boolean;
  /** 调用时主窗口是否在前台。 */
  focused: boolean;
  attentionRequested: boolean;
  /** 系统通知发送失败原因（非致命）。 */
  error?: string;
}

export interface TerminalStartInput {
  purpose?: "shell" | "gatewaySetup" | "gatewayStatus";
  cwd?: string;
  cols?: number;
  rows?: number;
  initialInput?: string;
}

export interface TerminalOpenExternalInput {
  purpose?: "shell" | "gatewaySetup" | "gatewayStatus";
  cwd?: string;
}

export interface TerminalStartResult {
  terminalId: string;
  cwd: string;
  shell: string;
  profile: string;
  hermesHome: string;
  managedRuntime?: {
    runtimeVersion: string;
    executablePath: string;
    shimDir: string;
  } | null;
}

export interface ExternalTerminalResult {
  ok: boolean;
  terminal: string;
  cwd: string;
  command: string;
}

export interface TerminalEventPayload {
  terminalId: string;
  kind: "data" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
  message?: string | null;
}

// Right-rail rich preview (issue #233). Mirrors the Rust commands in
// src/commands/preview.rs and the upstream Electron preload API.
export interface ReadWorkspaceFileInput {
  /** Absolute path, or relative to `root`. Must resolve inside `root`. */
  path: string;
  /** Session workspace root; reads are confined to this directory. */
  root: string;
}

export interface FilePreview {
  /** UTF-8 text content, when the file is textual. */
  text?: string;
  /** `data:<mime>;base64,...` for previewable images. */
  dataUrl?: string;
  /** Full size on disk in bytes. */
  byteSize: number;
  /** True when the content is binary (no text preview). */
  binary: boolean;
  /** True when `text` was cut at the 512 KB cap. */
  truncated: boolean;
}

export interface WriteWorkspaceFileInput {
  /** Absolute path, or relative to `root`. Must resolve inside `root`. */
  path: string;
  /** Session workspace root; writes are confined to this directory. */
  root: string;
  /** New UTF-8 file content. */
  content: string;
}

export interface WriteWorkspaceFileResult {
  /** Canonical path actually written. */
  path: string;
}

export interface WatchPreviewFileResult {
  watchId: string;
}

export interface PreviewFileChangedPayload {
  watchId: string;
  path: string;
}

export interface DesktopFileDropPayload {
  phase: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position?: {
    x: number;
    y: number;
  };
}

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __TAURI_INTERNALS__?: unknown;
    __HERMES_RUNTIME__?: {
      platform?: RuntimePlatform;
      apiBaseUrl?: string;
      /** Actual dashboard API origin even in Vite dev, where apiBaseUrl is intentionally hidden. */
      dashboardApiBaseUrl?: string;
      gatewayUrl?: string;
      sessionToken?: string;
      currentProfile?: string;
      /** "managed" for desktop-owned runtime, "local"/"remote" for attached backends. */
      connectionMode?: ConnectionMode;
    };
    hermesDesktop?: {
      windowType: "electron" | "tauri";
      request(input: ElectronApiRequestInput): Promise<ElectronApiRequestResult>;
      externalRequest?(input: ElectronApiRequestInput): Promise<ElectronApiRequestResult>;
      uploadFile?(input: FileUploadInput): Promise<ElectronApiRequestResult>;
      downloadExternalImage?(input: DownloadExternalImageInput): Promise<DownloadedImageResult>;
      pickFiles?(): Promise<ElectronFilePickerResult>;
      pickDirectory?(): Promise<ElectronFilePickerResult>;
      requestMicrophoneAccess?(): Promise<boolean>;
      createWorkspaceProject?(): Promise<ElectronFilePickerResult>;
      openWorkspacePath?(input: { path: string }): Promise<ElectronApiRequestResult>;
      openExternalUrl?(input: { url: string }): Promise<ElectronSimpleResult>;
      exportLogSnapshot?(input: ExportLogSnapshotInput): Promise<ExportLogSnapshotResult>;
      exportDebugBundle?(input?: ExportDebugBundleInput): Promise<ExportDebugBundleResult>;
      environmentCheck?(): Promise<EnvironmentCheckResult>;
      checkDesktopUpdate?(): Promise<DesktopUpdateManifestFetchResult>;
      getRuntimeConfig?(): Window["__HERMES_RUNTIME__"];
      refreshGatewayUrl?(): Promise<{ gatewayUrl: string; sessionToken?: string }>;
      getRuntimeInfo?(): Promise<RuntimeInfo>;
      checkRuntimeUpdate?(): Promise<RuntimeUpdateCheckResult>;
      installRuntimeUpdate?(): Promise<RuntimeInstallUpdateResult>;
      rollbackRuntime?(): Promise<RuntimeInstallUpdateResult>;
      exportProfileBackup?(): Promise<BackupExportResult>;
      importProfileBackup?(): Promise<BackupImportResult>;
      switchProfile?(input: SwitchProfileInput): Promise<SwitchProfileResult>;
      getConnectionConfig?(): Promise<ConnectionConfigView>;
      saveConnectionConfig?(input: ConnectionConfigInput): Promise<ConnectionConfigView>;
      applyConnectionConfig?(input: ConnectionConfigInput): Promise<ApplyConnectionResult>;
      testConnectionConfig?(input: ConnectionConfigInput): Promise<TestConnectionResult>;
      probeConnectionConfig?(remoteUrl: string): Promise<ProbeConnectionResult>;
      scanConfigMigration?(input?: ConfigMigrationScanInput): Promise<ConfigMigrationScanResult>;
      importConfigMigration?(input: ConfigMigrationImportInput): Promise<ConfigMigrationImportResult>;
      getYoloMode?(): Promise<YoloModeStatus>;
      setYoloMode?(input: SetYoloModeInput): Promise<SetYoloModeResult>;
      imOnboardingState?(input: ImOnboardingStateInput): Promise<ImOnboardingStateResult>;
      imOnboardingBegin?(input: ImOnboardingBeginInput): Promise<ImOnboardingBeginResult>;
      imOnboardingPoll?(input: ImOnboardingPollInput): Promise<ImOnboardingPollResult>;
      imOnboardingApply?(input: ImOnboardingApplyInput): Promise<ImOnboardingApplyResult>;
      readSkillMarkdown?(input: { name: string }): Promise<SkillMarkdownResult>;
      readMemory?(): Promise<MemoryInfo>;
      addMemoryEntry?(content: string): Promise<MemoryMutationResult>;
      updateMemoryEntry?(index: number, content: string): Promise<MemoryMutationResult>;
      removeMemoryEntry?(index: number): Promise<boolean>;
      writeUserProfile?(content: string): Promise<MemoryMutationResult>;
      uiStoreSnapshot?(): Promise<UiStoreSnapshot>;
      uiStoreSetKv?(input: { key: string; value: unknown }): Promise<boolean>;
      uiStoreRemoveKv?(input: { key: string }): Promise<boolean>;
      uiStoreRecordTurnStats?(input: UiTurnStats): Promise<boolean>;
      uiStoreGetTurnStats?(input: { sessionId: string }): Promise<UiTurnStats[]>;
      uiStoreGetTurnStatsWindow?(input: { sinceMs?: number; limit?: number }): Promise<UiTurnStats[]>;
      uiStoreRecordEvent?(input: UiEventInput): Promise<boolean>;
      desktopNotify?(input: DesktopNotifyInput): Promise<DesktopNotifyResult>;
      terminalStart?(input: TerminalStartInput): Promise<TerminalStartResult>;
      terminalOpenExternal?(input: TerminalOpenExternalInput): Promise<ExternalTerminalResult>;
      terminalWrite?(input: { terminalId: string; data: string }): Promise<boolean>;
      terminalResize?(input: { terminalId: string; cols: number; rows: number }): Promise<boolean>;
      terminalClose?(input: { terminalId: string }): Promise<boolean>;
      onTerminalOutput?(handler: (event: TerminalEventPayload) => void): () => void;
      readWorkspaceFile?(input: ReadWorkspaceFileInput): Promise<FilePreview>;
      writeWorkspaceFile?(input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult>;
      watchPreviewFile?(input: { path: string }): Promise<WatchPreviewFileResult>;
      stopPreviewFileWatch?(input: { watchId: string }): Promise<boolean>;
      onPreviewFileChanged?(handler: (payload: PreviewFileChangedPayload) => void): () => void;
      onFileDrop?(handler: (payload: DesktopFileDropPayload) => void): () => void;
      onSystemResume?(handler: () => void): () => void;
      /** Native webview page zoom (reflows layout + viewport) for the interface
       *  scale setting. Fire-and-forget; far better than CSS `zoom`, which leaves
       *  viewport units un-scaled and overflows the fixed window. */
      setUiZoom?(factor: number): void;
    };
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function detectHostOS(): HostOS {
  if (typeof navigator === "undefined") return "unknown";
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const probe = `${platform} ${userAgent}`.toLowerCase();
  if (probe.includes("mac")) return "macos";
  if (probe.includes("win")) return "windows";
  if (probe.includes("linux") || probe.includes("x11")) return "linux";
  return "unknown";
}

export function applyHostOSToDOM(os: HostOS = detectHostOS()): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.hermesHostOs = os;
  if (document.body) document.body.dataset.hermesHostOs = os;
}

export const runtime = {
  get platform(): RuntimePlatform {
    if (window.__HERMES_RUNTIME__?.platform) return window.__HERMES_RUNTIME__.platform;
    if (window.__TAURI_INTERNALS__) return "tauri";
    return "web";
  },

  getSessionToken(): string | undefined {
    return window.__HERMES_RUNTIME__?.sessionToken ?? window.__HERMES_SESSION_TOKEN__;
  },

  getConnectionMode(): ConnectionMode {
    return window.__HERMES_RUNTIME__?.connectionMode ?? "managed";
  },

  /** True when the desktop owns and can restart the bundled Hermes runtime. */
  isManaged(): boolean {
    return this.getConnectionMode() === "managed";
  },

  /** True when the desktop is attached to a loopback Hermes Agent CLI dashboard. */
  isLocalConnection(): boolean {
    return this.getConnectionMode() === "local";
  },

  /** True when the desktop is attached to a remote Hermes Agent (shell mode). */
  isRemote(): boolean {
    return this.getConnectionMode() === "remote";
  },

  /** True for either attached backend where process/profile lifecycle is external. */
  isAttached(): boolean {
    return this.getConnectionMode() !== "managed";
  },

  getApiUrl(path: string): string {
    const baseUrl = window.__HERMES_RUNTIME__?.apiBaseUrl;
    if (!baseUrl) return path;
    return `${trimTrailingSlash(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
  },

  getGatewayUrl(): string {
    if (window.__HERMES_RUNTIME__?.gatewayUrl) {
      return window.__HERMES_RUNTIME__.gatewayUrl;
    }

    const url = new URL("/api/ws", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = this.getSessionToken();
    if (token) url.searchParams.set("token", token);
    return url.toString();
  },

  async refreshGatewayUrl(): Promise<string> {
    if (window.hermesDesktop?.refreshGatewayUrl) {
      try {
        const result = await window.hermesDesktop.refreshGatewayUrl();
        if (window.__HERMES_RUNTIME__) {
          window.__HERMES_RUNTIME__.gatewayUrl = result.gatewayUrl;
          if (result.sessionToken) {
            window.__HERMES_RUNTIME__.sessionToken = result.sessionToken;
          }
        }
        return result.gatewayUrl;
      } catch {}
    }
    return this.getGatewayUrl();
  },

  // 桌面端启动时由主进程把 sticky default 通过 --hermes-current-profile arg
  // 推过来；web 模式下没有这个值，调用方可以走 GET /api/profiles/active
  // 来 fallback。
  getCurrentProfile(): string | undefined {
    return window.__HERMES_RUNTIME__?.currentProfile;
  },

  // 桌面端 switchProfile IPC 成功后调用——把新 token / gateway URL / profile
  // 名同步进 __HERMES_RUNTIME__，让后续 transport 调用看到新值。apiBaseUrl
  // 通常不变（dashboard 重启时端口固定），但偶尔被 fallback 端口顶到旁边
  // 所以也一起更新。
  applySwitchProfileResult(result: SwitchProfileResult): void {
    if (!result.ok || !window.__HERMES_RUNTIME__) return;
    if (result.apiBaseUrl) window.__HERMES_RUNTIME__.apiBaseUrl = result.apiBaseUrl;
    if (result.gatewayUrl) window.__HERMES_RUNTIME__.gatewayUrl = result.gatewayUrl;
    if (result.sessionToken) window.__HERMES_RUNTIME__.sessionToken = result.sessionToken;
    if (result.profileName) window.__HERMES_RUNTIME__.currentProfile = result.profileName;
  },

  // After set_yolo_mode restarts the managed runtime, the session token rotated
  // and the gateway URL/port may have shifted. Adopt the new values so the next
  // transport call and WebSocket reconnect use the live dashboard.
  applyYoloRestartResult(result: SetYoloModeResult): void {
    if (!result.ok || !result.restarted || !window.__HERMES_RUNTIME__) return;
    if (result.apiBaseUrl) {
      // In Vite dev `apiBaseUrl` is intentionally undefined (relative paths go
      // through the proxy); only refresh it when production already set it.
      if (window.__HERMES_RUNTIME__.apiBaseUrl) {
        window.__HERMES_RUNTIME__.apiBaseUrl = result.apiBaseUrl;
      }
      window.__HERMES_RUNTIME__.dashboardApiBaseUrl = result.apiBaseUrl;
    }
    if (result.gatewayUrl) window.__HERMES_RUNTIME__.gatewayUrl = result.gatewayUrl;
    if (result.sessionToken) window.__HERMES_RUNTIME__.sessionToken = result.sessionToken;
  },
  applyConfigMigrationResult(result: ConfigMigrationImportResult): void {
    if (!result.ok || !window.__HERMES_RUNTIME__) return;
    if (result.apiBaseUrl) {
      if (window.__HERMES_RUNTIME__.apiBaseUrl) {
        window.__HERMES_RUNTIME__.apiBaseUrl = result.apiBaseUrl;
      }
      window.__HERMES_RUNTIME__.dashboardApiBaseUrl = result.apiBaseUrl;
    }
    if (result.gatewayUrl) window.__HERMES_RUNTIME__.gatewayUrl = result.gatewayUrl;
    if (result.sessionToken) window.__HERMES_RUNTIME__.sessionToken = result.sessionToken;
    if (result.targetProfileName) window.__HERMES_RUNTIME__.currentProfile = result.targetProfileName;
  },
  applyBackupImportResult(result: BackupImportResult): void {
    if ((!result.ok && !result.recoveredPreviousProfile) || !window.__HERMES_RUNTIME__) return;
    if (result.apiBaseUrl) {
      if (window.__HERMES_RUNTIME__.apiBaseUrl) {
        window.__HERMES_RUNTIME__.apiBaseUrl = result.apiBaseUrl;
      }
      window.__HERMES_RUNTIME__.dashboardApiBaseUrl = result.apiBaseUrl;
    }
    if (result.gatewayUrl) window.__HERMES_RUNTIME__.gatewayUrl = result.gatewayUrl;
    if (result.sessionToken) window.__HERMES_RUNTIME__.sessionToken = result.sessionToken;
    if (result.ok && result.targetProfileName) window.__HERMES_RUNTIME__.currentProfile = result.targetProfileName;
  },
};
