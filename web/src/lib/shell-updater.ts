// Track C: in-app shell self-update via @tauri-apps/plugin-updater.
//
// Distinct from the runtime channel (Ed25519, replaces the Python kernel) and
// the UI channel (hermesui override): this downloads and installs a full
// signed installer for the Tauri shell itself, then relaunches. Endpoints and
// the minisign pubkey are configured in tauri.conf.json's plugins.updater.
//
// Everything degrades gracefully: on any platform where the plugin is absent
// or unconfigured, the helpers resolve to "unavailable" and the caller falls
// back to the notify-and-guide flow (lib/desktop-update.ts).

import { runtime } from "./runtime";

export interface ShellUpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  /** Download + install the update, reporting bytes downloaded, then relaunch. */
  downloadInstallAndRelaunch: (onProgress?: (event: ShellUpdateProgress) => void) => Promise<void>;
}

export type ShellUpdateProgress =
  | { phase: "started"; contentLength?: number }
  | { phase: "downloading"; downloaded: number; contentLength?: number }
  | { phase: "finished" };

function updaterAvailable(): boolean {
  // The updater plugin only exists in the Tauri shell. Guard the dynamic
  // import so web/electron builds never try to load it.
  return typeof window !== "undefined" && runtime.platform === "tauri";
}

/**
 * Check the configured update endpoints. Returns null when up to date, the
 * plugin is unavailable/unconfigured, or the check errors — callers treat all
 * of these as "no in-app update, use the fallback notice".
 */
export async function checkShellUpdate(): Promise<ShellUpdateInfo | null> {
  if (!updaterAvailable()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? undefined,
      downloadInstallAndRelaunch: async (onProgress) => {
        let downloaded = 0;
        let contentLength: number | undefined;
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              contentLength = event.data.contentLength;
              onProgress?.({ phase: "started", contentLength });
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              onProgress?.({ phase: "downloading", downloaded, contentLength });
              break;
            case "Finished":
              onProgress?.({ phase: "finished" });
              break;
          }
        });
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch (error) {
    // Unconfigured endpoints, network failure, signature mismatch, etc. —
    // never surface as a hard error; the notify-and-guide path takes over.
    console.warn("shell updater check failed; falling back to notice", error);
    return null;
  }
}
