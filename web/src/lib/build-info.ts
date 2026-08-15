export const UNKNOWN_VALUE = "—";
export const UNKNOWN_DATE = "日期未知";

/** Desktop shell version (Tauri package version). */
export const DESKTOP_VERSION = import.meta.env.VITE_HERMES_DESKTOP_VERSION || UNKNOWN_VALUE;

/** Backend/kernel version the frontend expects to connect to.
 *
 * This must be kept in sync with the `version` field in
 * `D:\hermes-agent-cn\pyproject.toml` / `hermes_cli.__version__`. A backend
 * `/api/version` response that does not match this value triggers a fatal
 * compatibility dialog and force-quit.
 */
export const EXPECTED_BACKEND_VERSION = "0.8.0-rc5";
export const BUILD_COMMIT = import.meta.env.VITE_HERMES_BUILD_COMMIT || "unknown";
export const BUILD_DATE = import.meta.env.VITE_HERMES_BUILD_DATE || "unknown";

export function versionLabel(version: string | undefined): string {
  const value = version?.trim();
  if (!value || value === "unknown" || value === UNKNOWN_VALUE) return `v${UNKNOWN_VALUE}`;
  return value.startsWith("v") || value.startsWith("V") ? value : `v${value}`;
}
