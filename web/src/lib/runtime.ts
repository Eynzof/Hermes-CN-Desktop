import type {
  BackupExportResult,
  BackupImportResult,
  ConfigMigrationImportInput,
  ConfigMigrationImportResult,
  ConfigMigrationScanInput,
  ConfigMigrationScanResult,
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
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
  SetYoloModeInput,
  SetYoloModeResult,
  SwitchProfileInput,
  SwitchProfileResult,
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
      transport?: "ws" | "sse";
    };
    hermesDesktop?: {
      windowType: "electron" | "tauri";
      request(input: ElectronApiRequestInput): Promise<ElectronApiRequestResult>;
      externalRequest?(input: ElectronApiRequestInput): Promise<ElectronApiRequestResult>;
      uploadFile?(input: FileUploadInput): Promise<ElectronApiRequestResult>;
      pickFiles?(): Promise<ElectronFilePickerResult>;
      pickDirectory?(): Promise<ElectronFilePickerResult>;
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
      terminalStart?(input: TerminalStartInput): Promise<TerminalStartResult>;
      terminalOpenExternal?(input: TerminalOpenExternalInput): Promise<ExternalTerminalResult>;
      terminalWrite?(input: { terminalId: string; data: string }): Promise<boolean>;
      terminalResize?(input: { terminalId: string; cols: number; rows: number }): Promise<boolean>;
      terminalClose?(input: { terminalId: string }): Promise<boolean>;
      onTerminalOutput?(handler: (event: TerminalEventPayload) => void): () => void;
      onSystemResume?(handler: () => void): () => void;
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
  // transport call and SSE reconnect use the live dashboard.
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
