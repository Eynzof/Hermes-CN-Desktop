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
