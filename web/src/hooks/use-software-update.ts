import { useSyncExternalStore } from "react";
import {
  subscribeSoftwareUpdate, getSoftwareUpdateState, checkSoftwareUpdate,
  downloadSoftwareUpdate, cancelSoftwareUpdate, applySoftwareUpdate, refreshSoftwareUpdate, rollbackSoftwareUpdate,
} from "@/lib/software-update";

export function useSoftwareUpdate() {
  const state = useSyncExternalStore(subscribeSoftwareUpdate, getSoftwareUpdateState, getSoftwareUpdateState);
  return {
    state,
    busy: ["checking", "downloading", "applying"].includes(state.phase),
    supported: typeof window !== "undefined" && Boolean(window.hermesDesktop?.softwareUpdateSnapshot),
    check: checkSoftwareUpdate, download: downloadSoftwareUpdate, cancel: cancelSoftwareUpdate,
    rollback: rollbackSoftwareUpdate, apply: applySoftwareUpdate, refresh: refreshSoftwareUpdate,
  };
}
