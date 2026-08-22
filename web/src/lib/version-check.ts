import { runtime } from "./runtime";
import { DESKTOP_VERSION, EXPECTED_BACKEND_VERSION } from "./build-info";
import {
  expectedCoreSeriesLabel,
  isDesktopCoreCompatible,
} from "./version-compatibility";
import type { ConnectionMode } from "@hermes/protocol";

export interface BackendVersionInfo {
  version: string;
  name?: string;
}

export type BackendRecoveryReason =
  | "managed-runtime-offline"
  | "external-backend-unreachable"
  | "external-backend-auth-required";

export type VersionCheckState =
  | { kind: "unchecked" }
  | { kind: "deferred"; reason: BackendRecoveryReason }
  | { kind: "ok"; backendVersion: string }
  | { kind: "mismatch"; backendVersion: string; expectedVersion: string }
  | { kind: "unavailable"; reason: string };

export interface VersionCheckOptions {
  connectionMode?: ConnectionMode;
  expectedVersion?: string;
}

let state: VersionCheckState = { kind: "unchecked" };

/**
 * Kernel version recorded from the managed runtime install record (set by the
 * runtime hooks). In managed mode this is an integrity check: the running Core
 * must match its install record exactly. Desktop↔Core product compatibility is
 * evaluated separately through compatibility/desktop-core.json.
 */
let runtimeKernelVersion: string | null = null;

export function recordRuntimeKernelVersion(version: string | null | undefined): void {
  runtimeKernelVersion = version?.trim() || null;
}

/** The backend version the frontend currently expects to connect to. */
export function expectedBackendVersion(): string {
  return runtimeKernelVersion ?? EXPECTED_BACKEND_VERSION;
}

function expectedBackendContract(explicit?: string): string {
  return explicit
    ?? runtimeKernelVersion
    ?? expectedCoreSeriesLabel(DESKTOP_VERSION)
    ?? EXPECTED_BACKEND_VERSION;
}

export function getVersionCheckState(): VersionCheckState {
  return state;
}

export function resetVersionCheck(): void {
  state = { kind: "unchecked" };
  runtimeKernelVersion = null;
}

/**
 * Allow the recovery UI to mount while the user has explicitly stopped or
 * uninstalled the managed runtime. Runtime control results reset this state
 * before a subsequently started backend can serve REST or WebSocket traffic.
 */
export function deferBackendVersionCheckForOfflineRuntime(): void {
  state = { kind: "deferred", reason: "managed-runtime-offline" };
}

function isDevBypassEnabled(): boolean {
  try {
    return import.meta.env.DEV === true && import.meta.env.VITE_HERMES_SKIP_VERSION_CHECK === "1";
  } catch {
    return false;
  }
}

function parseBackendVersion(data: unknown): BackendVersionInfo {
  if (!data || typeof data !== "object" || typeof (data as { version?: unknown }).version !== "string") {
    throw new Error("backend version response missing version string");
  }
  return data as BackendVersionInfo;
}

class BackendVersionHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
  }
}

function isExternalConnection(mode: ConnectionMode | undefined): boolean {
  return mode === "local" || mode === "remote";
}

function ipcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isExternalBackendUnreachable(error: unknown): boolean {
  const code = ipcErrorCode(error);
  if (code === "dashboard_unreachable") return true;

  // reqwest reports a response timeout as api_proxy/proxy_error rather than a
  // connect error. It is still an unreachable target from the recovery UI's
  // perspective, while all other proxy errors remain strict.
  return code === "proxy_error"
    && error instanceof Error
    && error.message.includes("Request timed out");
}

/**
 * Fetch /api/version without going through the compatibility-gated transport
 * helper. Tauri must use its Rust HTTP proxy: release WebViews load from a
 * custom protocol origin (`hermesui:` on macOS/Linux and
 * `http://hermesui.localhost` on Windows), so a native browser fetch would be
 * rejected by the dashboard's intentionally narrow localhost CORS policy.
 */
async function fetchBackendVersion(apiBaseUrl?: string): Promise<BackendVersionInfo> {
  if (runtime.platform === "tauri") {
    const request = window.hermesDesktop?.request;
    if (!request) {
      throw new Error("desktop IPC bridge unavailable");
    }
    const response = await request({ path: "/api/version", method: "GET" });
    if (!response.ok) {
      throw new BackendVersionHttpError(response.status, response.body);
    }
    return parseBackendVersion(JSON.parse(response.body));
  }

  const url = apiBaseUrl
    ? `${apiBaseUrl.replace(/\/$/, "")}/api/version`
    : runtime.getApiUrl("/api/version");
  const response = await fetch(url);
  if (!response.ok) {
    throw new BackendVersionHttpError(response.status, await response.text());
  }
  return parseBackendVersion(await response.json());
}

export async function verifyBackendVersion(
  apiBaseUrl?: string,
  options: VersionCheckOptions = {},
): Promise<VersionCheckState> {
  const exactExpected = options.expectedVersion ?? runtimeKernelVersion;
  const expected = expectedBackendContract(options.expectedVersion);
  if (runtime.platform === "web") {
    // Web/browser-companion mode: no managed runtime; skip the gate.
    state = { kind: "ok", backendVersion: "web" };
    return state;
  }

  if (isDevBypassEnabled()) {
    state = { kind: "ok", backendVersion: expected };
    return state;
  }

  try {
    const info = await fetchBackendVersion(apiBaseUrl);
    const exactMismatch = exactExpected !== null && exactExpected !== undefined
      && info.version !== exactExpected;
    const seriesMismatch = !isDesktopCoreCompatible(DESKTOP_VERSION, info.version);
    if (exactMismatch || seriesMismatch) {
      state = {
        kind: "mismatch",
        backendVersion: info.version,
        expectedVersion: expected,
      };
      return state;
    }
    state = { kind: "ok", backendVersion: info.version };
    return state;
  } catch (error) {
    if (isExternalConnection(options.connectionMode)) {
      if (error instanceof BackendVersionHttpError && (error.status === 401 || error.status === 403)) {
        state = { kind: "deferred", reason: "external-backend-auth-required" };
        return state;
      }
      if (isExternalBackendUnreachable(error)) {
        state = { kind: "deferred", reason: "external-backend-unreachable" };
        return state;
      }
    }
    state = {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
    return state;
  }
}

async function fatalErrorAndExit(title: string, message: string): Promise<never> {
  if (runtime.platform === "tauri" && window.hermesDesktop?.fatalErrorAndExit) {
    await window.hermesDesktop.fatalErrorAndExit({ title, message });
  } else {
    // Fallback for web/dev/non-Tauri contexts.
    if (typeof window.alert === "function") {
      window.alert(`${title}\n\n${message}`);
    }
    if (typeof window.close === "function") {
      window.close();
    }
  }
  // Defensive: if the dialog/close did not terminate the process, throw.
  throw new Error(`${title}: ${message}`);
}

export function assertCompatible(): void {
  if (state.kind === "ok" || state.kind === "deferred") return;

  // Web/browser-companion mode has no managed runtime; skip the gate.
  if (runtime.platform === "web") {
    state = { kind: "ok", backendVersion: "web" };
    return;
  }

  if (state.kind === "mismatch") {
    const message =
      `前端与后端版本不兼容。\n` +
      `当前 Desktop 兼容的 Core：${state.expectedVersion}\n` +
      `后端实际版本：${state.backendVersion}\n\n` +
      `请升级 Hermes Agent CN Desktop 到与后端匹配的版本，或重新安装内置内核。`;
    void fatalErrorAndExit("版本不匹配", message);
    throw new Error(`backend version mismatch: expected ${state.expectedVersion}, got ${state.backendVersion}`);
  }

  if (state.kind === "unavailable") {
    // The backend does not expose the API (very old backend) or is unreachable.
    // For strict enforcement, treat this as a fatal error in Tauri builds.
    const message =
      `无法验证后端版本：${state.reason}\n\n` +
      `请确认后端已启动，且与当前桌面端版本兼容。`;
    void fatalErrorAndExit("版本验证失败", message);
    throw new Error(`backend version unavailable: ${state.reason}`);
  }

  // unchecked: trigger the async verification. The current call must still
  // fail fast so callers don't proceed against an unchecked backend.
  void verifyBackendVersion(undefined, { connectionMode: runtime.getConnectionMode() }).then((s) => {
    if (s.kind !== "ok" && s.kind !== "deferred") assertCompatible();
  });
  throw new Error("backend version check has not completed");
}
