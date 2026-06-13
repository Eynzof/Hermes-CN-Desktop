export const CHANNEL_PREFIX = "hermes_desktop";

const ch = (name: string) => `${CHANNEL_PREFIX}:${name}` as const;

export const Channels = {
  apiRequest: ch("api-request"),
  externalRequest: ch("external-request"),
  uploadFile: ch("upload-file"),
  pickFiles: ch("pick-files"),
  pickDirectory: ch("pick-directory"),
  createWorkspaceProject: ch("create-workspace-project"),
  openWorkspacePath: ch("open-workspace-path"),
  refreshGatewayUrl: ch("refresh-gateway-url"),
  runtimeInfo: ch("runtime-info"),
  runtimeCheckUpdate: ch("runtime-check-update"),
  runtimeInstallUpdate: ch("runtime-install-update"),
  runtimeRollback: ch("runtime-rollback"),
  desktopCheckUpdate: ch("desktop-check-update"),
  switchProfile: ch("switch-profile"),
  configMigrationScan: ch("config-migration-scan"),
  configMigrationImport: ch("config-migration-import"),
  getSessionToken: ch("get-session-token"),
  systemResume: ch("system-resume"),
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

export interface ApiRequestInput {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface ApiRequestResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface FileUploadInput {
  sessionId: string;
  name: string;
  type?: string;
  data: ArrayBuffer;
}

export interface FilePickerResult {
  canceled: boolean;
  paths: string[];
}

export interface ExportLogSnapshotInput {
  fileName: string;
  content: string;
  format: "log" | "jsonl";
}

export interface ExportLogSnapshotResult {
  ok: boolean;
  canceled: boolean;
  path?: string;
  bytes: number;
  error?: string;
}

export interface WorkspacePathInput {
  path: string;
}

export interface RuntimeInstallRecord {
  schemaVersion: number;
  runtimeVersion: string;
  kernelVersion: string;
  runtimeFlavor: string;
  runtimeRevision: number;
  platform: string;
  arch: string;
  path: string;
  executablePath: string;
  source: "bundled" | "update" | "dev" | "local-source" | string;
  installedAt: string;
  sourceRepo?: string;
  sourceCommit?: string;
  localDirtyHash?: string | null;
  artifactSha256?: string;
  previousRuntimeVersion?: string;
}

export interface RuntimeSourceCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface RuntimeSourceInfo {
  repo: string;
  headCommit?: string;
  headShortCommit?: string;
  dirty?: boolean;
  recentCommits: RuntimeSourceCommit[];
}

export interface RuntimeProcessInfo {
  apiBaseUrl: string;
  gatewayUrl: string;
  hermesHome: string;
  hermesHomeBase: string;
  currentProfile: string;
  ownsProcess: boolean;
  pid?: number;
  commandProgram?: string;
  commandArgs: string[];
  commandLine?: string;
  gatewayRuntimeDir?: string;
  gatewayLockDir?: string;
  ownershipMarkerPath?: string;
  ownershipState?: string;
  sessionTokenPresent: boolean;
  /** True while the Rust /api/ws relay (fallback socket path) is connected. */
  gatewayWsRelayActive: boolean;
}

export interface RuntimeInfo {
  mode:
    | "managed"
    | "managed-pending"
    | "external-command"
    | "external-path"
    | "dev-command"
    | "dev-source"
    | "path-fallback"
    | "missing"
    | string;
  packaged: boolean;
  platform: string;
  arch: string;
  current?: RuntimeInstallRecord;
  runtimeRoot: string;
  currentRecordPath: string;
  versionsDir: string;
  downloadsDir: string;
  gatewayRuntimeDir: string;
  updateManifestUrl?: string;
  updatesConfigured: boolean;
  executableSha256?: string;
  source?: RuntimeSourceInfo;
  process?: RuntimeProcessInfo;
  lastError?: string;
}


export type EnvironmentCheckStatus = "ok" | "warning" | "error" | "unknown";

export type EnvironmentCheckCategory = "core" | "runtime" | "tools" | "browser" | "paths";

export interface EnvironmentCheckItem {
  id: string;
  category: EnvironmentCheckCategory;
  label: string;
  status: EnvironmentCheckStatus;
  required: boolean;
  summary: string;
  version?: string;
  path?: string;
  details?: string;
  recommendation?: string;
}

export interface EnvironmentCheckResult {
  generatedAtMs: number;
  platform: string;
  arch: string;
  runtimeRoot: string;
  hermesHome: string;
  currentProfile: string;
  items: EnvironmentCheckItem[];
}


export interface DesktopUpdateAsset {
  label?: string;
  platform?: string;
  fileName?: string;
  size?: number;
  sha256?: string;
  url?: string;
  versionedUrl?: string;
  sourceUrl?: string;
  baiduPanUrl?: string;
  baiduPanCode?: string;
  quarkPanUrl?: string;
  quarkPanCode?: string;
}

export interface DesktopUpdateManifest {
  repository?: string;
  version?: string;
  semver?: string;
  publishedAt?: string;
  sourceUrl?: string;
  updatedAt?: string;
  assets?: Record<string, DesktopUpdateAsset>;
}

export interface DesktopUpdateManifestFetchResult {
  ok: boolean;
  manifestUrl: string;
  manifest?: DesktopUpdateManifest;
  error?: string;
  checkedAtMs: number;
}

export interface DesktopUpdateCheckResult extends DesktopUpdateManifestFetchResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl: string;
  sourceUrl?: string;
}

export interface RuntimeUpdateManifest {
  schemaVersion: number;
  channel: string;
  runtimeVersion: string;
  kernelVersion: string;
  runtimeFlavor: string;
  runtimeRevision: number;
  platform: string;
  arch: string;
  artifactUrl: string;
  sha256: string;
  signature: string;
  sourceRepo: string;
  sourceCommit: string;
  minAppVersion?: string;
  createdAt?: string;
}

export interface RuntimeUpdateCheckResult {
  ok: boolean;
  updateAvailable: boolean;
  currentRuntimeVersion?: string;
  manifest?: RuntimeUpdateManifest;
  error?: string;
}

export interface RuntimeInstallUpdateResult {
  ok: boolean;
  installed?: RuntimeInstallRecord;
  previous?: RuntimeInstallRecord;
  error?: string;
}

export interface SwitchProfileInput {
  name: string;
}

// Desktop-only IM onboarding bridge types. Secrets are returned as
// RedactedValue and must not be cached or rendered in plaintext.
export type ImPlatform = "feishu" | "weixin";

export interface ImOnboardingStateInput {
  platform: ImPlatform;
}

export interface ImRedactedValue {
  isSet: boolean;
  redactedValue?: string | null;
  fingerprint?: string | null;
}

export interface ImOnboardingStateResult {
  platform: ImPlatform | string;
  currentProfile: string;
  hermesHome: string;
  envPath: string;
  configured: Record<string, ImRedactedValue>;
}

export interface ImOnboardingBeginInput {
  platform: ImPlatform;
  domain?: "feishu" | "lark" | string;
  botType?: string;
}

export interface ImOnboardingBeginResult {
  flowId: string;
  platform: ImPlatform | string;
  status: string;
  qrUrl?: string | null;
  qrScanData?: string | null;
  userCode?: string | null;
  intervalSeconds: number;
  expiresAtMs: number;
  message?: string | null;
}

export interface ImCredentialSummary {
  appId?: ImRedactedValue | null;
  appSecret?: ImRedactedValue | null;
  accountId?: ImRedactedValue | null;
  token?: ImRedactedValue | null;
  baseUrl?: string | null;
  domain?: string | null;
  userId?: ImRedactedValue | null;
  botName?: string | null;
  botOpenId?: ImRedactedValue | null;
  openId?: ImRedactedValue | null;
}

export interface ImOnboardingPollInput {
  platform: ImPlatform;
  flowId: string;
}

export interface ImOnboardingPollResult {
  flowId: string;
  platform: ImPlatform | string;
  status: string;
  qrUrl?: string | null;
  qrScanData?: string | null;
  intervalSeconds: number;
  expiresAtMs: number;
  credentialSummary?: ImCredentialSummary | null;
  message?: string | null;
}

export interface ImManualCredentials {
  appId?: string;
  appSecret?: string;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
}

export interface ImOnboardingApplyInput {
  platform: ImPlatform;
  flowId?: string;
  manualCredentials?: ImManualCredentials;
  settings: Record<string, string>;
  restartGateway?: boolean;
}

export interface ImRestartResult {
  requested: boolean;
  ok: boolean;
  status?: number | null;
  message?: string | null;
}

export interface ImOnboardingApplyResult {
  ok: boolean;
  platform: ImPlatform | string;
  currentProfile: string;
  envPath: string;
  backupPath?: string | null;
  written: Record<string, ImRedactedValue>;
  restart: ImRestartResult;
}

// Result of asking the desktop main process to swap the dashboard subprocess
// over to a different profile. On `ok: true`, the renderer must adopt the new
// `apiBaseUrl / gatewayUrl / sessionToken / hermesHome` (token is fresh; URL
// usually unchanged but may have shifted ports if the previous one was busy)
// and invalidate every profile-aware cache. On `ok: false`, the dashboard may
// have rolled back to the previous profile (`recoveredPreviousProfile: true`)
// or be down entirely (`recoveredPreviousProfile: false`); in the second case
// the user has to fix config and restart the desktop.

export interface SwitchProfileResult {
  ok: boolean;
  profileName?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionToken?: string;
  hermesHome?: string;
  error?: string;
  recoveredPreviousProfile?: boolean;
}

// "YOLO mode" maps to the backend HERMES_YOLO_MODE=1 env var (equivalent to the
// --yolo CLI flag): the agent auto-approves dangerous-command prompts. The
// backend freezes this at import, so the desktop persists a per-profile
// preference and (re)launches the managed runtime to apply it.

export interface ConfigMigrationScanInput {
  manualPath?: string;
}

export interface ConfigMigrationCopyEntry {
  path: string;
  kind: "file" | "directory";
  sizeBytes?: number;
  containsSecrets: boolean;
}

export interface ConfigMigrationCandidate {
  id: string;
  label: string;
  path: string;
  sourceKind: string;
  distro?: string;
  profileName?: string;
  recommendedTargetProfile: string;
  hasConfig: boolean;
  hasEnv: boolean;
  hasAuth: boolean;
  hasSkills: boolean;
  hasMemories: boolean;
  copyEntries: ConfigMigrationCopyEntry[];
  warnings: string[];
}

export interface ConfigMigrationScanResult {
  desktopHermesHome: string;
  currentProfile: string;
  candidates: ConfigMigrationCandidate[];
  warnings: string[];
}

export interface ConfigMigrationImportInput {
  sourcePath: string;
  targetProfileName?: string;
  recommendedTargetProfile?: string;
}

export interface ConfigMigrationImportResult {
  ok: boolean;
  targetProfileName?: string;
  hermesHome?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionToken?: string;
  importedEntries: string[];
  warnings: string[];
  error?: string;
}

export interface BackupExportResult {
  ok: boolean;
  canceled: boolean;
  profileName?: string;
  hermesHome?: string;
  backupPath?: string;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  error?: string;
}

export interface BackupImportResult {
  ok: boolean;
  canceled: boolean;
  targetProfileName?: string;
  hermesHome?: string;
  backupPath?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionToken?: string;
  importedEntries: string[];
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  error?: string;
  recoveredPreviousProfile?: boolean;
}

export interface YoloModeStatus {
  /** Persisted desktop preference for the active profile's HERMES_HOME. */
  enabled: boolean;
  /**
   * What the currently-running managed runtime was actually started with.
   * Differs from `enabled` only between a toggle and the restart that applies
   * it.
   */
  effective: boolean;
}

export interface SetYoloModeInput {
  enabled: boolean;
}

// On `restarted: true`, the renderer must adopt the fresh
// `apiBaseUrl / gatewayUrl / sessionToken` (the dashboard restarted and the
// session token rotated), just like SwitchProfileResult. On `restarted: false`
// the preference was saved but applies on the next desktop launch.
export interface SetYoloModeResult {
  ok: boolean;
  enabled: boolean;
  effective: boolean;
  restarted: boolean;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionToken?: string;
  error?: string;
}

// --- Connection config: local managed runtime vs remote Hermes Agent -------
// Mirrors the official desktop's connection IPC (token auth only). The token
// value never crosses to the renderer — only presence/preview signals.

export type ConnectionMode = "local" | "remote";

export interface ConnectionConfigInput {
  mode?: ConnectionMode;
  remoteUrl?: string;
  /** Empty/absent keeps the previously saved token. */
  remoteToken?: string;
}

export interface ConnectionConfigView {
  /** The saved (target) mode — may differ from effectiveMode until applied. */
  mode: ConnectionMode;
  remoteUrl: string;
  remoteTokenSet: boolean;
  /** "set" or "...XXXXXX" (last 6 chars); absent when no token is saved. */
  remoteTokenPreview?: string | null;
  /** True when HERMES_DESKTOP_REMOTE_URL forces the connection; UI read-only. */
  envOverride: boolean;
  /** What the running desktop is actually attached to right now. */
  effectiveMode: ConnectionMode;
}

export interface ProbeConnectionResult {
  reachable: boolean;
  /** The gateway requires OAuth login, which this desktop does not support yet. */
  authRequired: boolean;
  version?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  baseUrl: string;
  httpOk: boolean;
  httpStatus?: number;
  wsOk: boolean;
  authRequired: boolean;
  version?: string;
  error?: string;
}

// On `ok: true` the connection switched live; the renderer should reload the
// webview so transport, socket-path selection, and all query caches rebuild
// from get_runtime_config. On `ok: false` the previous backend is untouched
// (local→remote probes the remote before tearing anything down).
export interface ApplyConnectionResult {
  ok: boolean;
  mode: ConnectionMode;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionToken?: string;
  error?: string;
}
