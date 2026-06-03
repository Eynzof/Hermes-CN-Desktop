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
  gatewaySseProxyActive: boolean;
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
