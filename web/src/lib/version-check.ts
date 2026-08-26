import { runtime } from "./runtime";
import { EXPECTED_BACKEND_VERSION } from "./build-info";

export interface BackendVersionInfo {
  version: string;
  name?: string;
}

export type VersionCheckState =
  | { kind: "unchecked" }
  | { kind: "ok"; backendVersion: string }
  | { kind: "mismatch"; backendVersion: string; expectedVersion: string }
  | { kind: "unavailable"; reason: string };

let state: VersionCheckState = { kind: "unchecked" };

/**
 * Kernel version recorded from the managed runtime install record (set by the
 * runtime/app-update hooks). When present it is the preferred expected version
 * for the unified self-update flow — after a backend update the kernel is
 * verified against the manifest version, and the baked constant is only the
 * build-time fallback.
 */
let runtimeKernelVersion: string | null = null;

export function recordRuntimeKernelVersion(version: string | null | undefined): void {
  runtimeKernelVersion = version?.trim() || null;
}

/** The backend version the frontend currently expects to connect to. */
export function expectedBackendVersion(): string {
  return runtimeKernelVersion ?? EXPECTED_BACKEND_VERSION;
}

export function getVersionCheckState(): VersionCheckState {
  return state;
}

export function resetVersionCheck(): void {
  state = { kind: "unchecked" };
  runtimeKernelVersion = null;
}

function isDevBypassEnabled(): boolean {
  try {
    return import.meta.env.DEV === true && import.meta.env.VITE_HERMES_SKIP_VERSION_CHECK === "1";
  } catch {
    return false;
  }
}

/**
 * Fetch the backend version. In embedded mode the backend lives inside the
 * Rust process: `apiBaseUrl` is the `embedded://local` placeholder and there is
 * no HTTP endpoint — the version is read from Python via IPC
 * (`get_backend_version`). Non-embedded mode fetches /api/version directly,
 * bypassing the transport layer so the version check itself does not recurse
 * into assertCompatible(). The endpoint is public and requires no auth header.
 */
async function fetchBackendVersion(apiBaseUrl?: string): Promise<BackendVersionInfo> {
  const embedded =
    runtime.isEmbedded() || (typeof apiBaseUrl === "string" && apiBaseUrl === "embedded://local");
  if (embedded) {
    if (window.hermesDesktop?.getBackendVersion) {
      const info = await window.hermesDesktop.getBackendVersion();
      if (typeof info?.version !== "string") {
        throw new Error("embedded backend version response missing version string");
      }
      return info as BackendVersionInfo;
    }
    throw new Error("embedded backend version unavailable (no IPC bridge)");
  }

  const url = apiBaseUrl
    ? `${apiBaseUrl.replace(/\/$/, "")}/api/version`
    : runtime.getApiUrl("/api/version");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (typeof data?.version !== "string") {
    throw new Error("backend version response missing version string");
  }
  return data as BackendVersionInfo;
}

export async function verifyBackendVersion(
  apiBaseUrl?: string,
  expected = expectedBackendVersion(),
): Promise<VersionCheckState> {
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
    if (info.version !== expected) {
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
  if (state.kind === "ok") return;

  // Web/browser-companion mode has no managed runtime; skip the gate.
  if (runtime.platform === "web") {
    state = { kind: "ok", backendVersion: "web" };
    return;
  }

  if (state.kind === "mismatch") {
    const message =
      `前端与后端版本不兼容。\n` +
      `前端期望后端版本：${state.expectedVersion}\n` +
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
  void verifyBackendVersion().then((s) => {
    if (s.kind !== "ok") assertCompatible();
  });
  throw new Error("backend version check has not completed");
}
