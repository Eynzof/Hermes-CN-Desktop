export const UNKNOWN_VALUE = "—";
export const UNKNOWN_DATE = "日期未知";

/** Desktop shell version (Tauri package version). */
export const DESKTOP_VERSION = import.meta.env.VITE_HERMES_DESKTOP_VERSION || UNKNOWN_VALUE;

/** Fallback backend/kernel version used only when compatibility metadata is unavailable.
 *
 * Managed mode records the installed runtime's `kernelVersion` before the
 * initial integrity check. Product compatibility is sourced from
 * compatibility/desktop-core.json; this constant remains independent of the
 * Desktop shell version.
 */
export const EXPECTED_BACKEND_VERSION = "0.20.0";
export const BUILD_COMMIT = import.meta.env.VITE_HERMES_BUILD_COMMIT || "unknown";
export const BUILD_DATE = import.meta.env.VITE_HERMES_BUILD_DATE || "unknown";

export function versionLabel(version: string | undefined): string {
  const value = version?.trim();
  if (!value || value === "unknown" || value === UNKNOWN_VALUE) return `v${UNKNOWN_VALUE}`;
  return value.startsWith("v") || value.startsWith("V") ? value : `v${value}`;
}
