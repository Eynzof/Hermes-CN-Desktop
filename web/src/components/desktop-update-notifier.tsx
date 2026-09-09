import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import { useSoftwareUpdate } from "@/hooks/use-software-update";
import {
  acceptSoftwareUpdateState, checkSoftwareUpdate, getSoftwareUpdateState,
  postponeUpdate, refreshSoftwareUpdate, shouldRemindUpdate, updateImpact,
  UPDATE_INTERVAL_MS, UPDATE_REMINDER_KEY,
} from "@/lib/software-update";
import { readUiValue } from "@/lib/ui-store";
import s from "./desktop-update-notifier.module.css";

export const APP_UPDATE_INITIAL_DELAY_MS = 60_000;
export const APP_UPDATE_INTERVAL_MS = UPDATE_INTERVAL_MS;
export const APP_UPDATE_JITTER_MS = 30 * 60 * 1000;
export function nextAppUpdateDelay(random = Math.random) {
  return Math.round(APP_UPDATE_INTERVAL_MS + (random() * 2 - 1) * APP_UPDATE_JITTER_MS);
}

export function canOpenUpdateNotice(document: Document): boolean {
  const active = document.activeElement;
  return document.visibilityState === "visible" && document.hasFocus()
    && !document.querySelector('[role="dialog"][aria-modal="true"], [data-update-blocked="true"]')
    && !(active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)));
}

export function DesktopUpdateNotifier() {
  const { state, supported } = useSoftwareUpdate();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    let timer: number;
    let polling = false;
    const initialCheckAt = Date.now() + APP_UPDATE_INITIAL_DELAY_MS;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { await refreshSoftwareUpdate(); } finally { polling = false; }
      if (!disposed) setTick((n) => n + 1);
    };
    const checkDue = async () => {
      const current = getSoftwareUpdateState();
      if (Date.now() < initialCheckAt) return;
      if (!["checking", "downloading", "ready", "waiting", "applying"].includes(current.phase)
          && Date.now() - (current.checkedAt ?? 0) >= APP_UPDATE_INTERVAL_MS) {
        await checkSoftwareUpdate();
      }
    };
    const check = async () => {
      await checkDue();
      if (!disposed) timer = window.setTimeout(() => void check(), nextAppUpdateDelay());
    };
    const wake = () => { if (document.visibilityState === "visible") { void poll(); void checkDue(); } };
    const unlisten = window.hermesDesktop?.onSoftwareUpdateState?.(acceptSoftwareUpdateState);
    void poll();
    // Acknowledge only after the new React root has mounted.
    void window.hermesDesktop?.softwareUpdateAcknowledge?.().then((next) => { if (!disposed) acceptSoftwareUpdateState(next); }).catch(() => undefined);
    timer = window.setTimeout(() => void check(), APP_UPDATE_INITIAL_DELAY_MS);
    const interval = window.setInterval(() => void poll(), 5000);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true; unlisten?.(); window.clearTimeout(timer); window.clearInterval(interval);
      window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake);
    };
  }, [supported]);

  useEffect(() => {
    if (open && !["available", "ready"].includes(state.phase)) { setOpen(false); return; }
    if (!supported || open || location.pathname === "/updates" || location.pathname === "/guide") return;
    if (canOpenUpdateNotice(document) && shouldRemindUpdate(state, readUiValue(UPDATE_REMINDER_KEY, {}))) setOpen(true);
  }, [state, supported, open, tick, location.pathname]);

  const close = () => { postponeUpdate(state); setOpen(false); };
  const ready = state.phase === "ready";
  const applying = state.phase === "applying" && !state.reloadRequired;
  return (
    <Dialog.Root open={open || applying} onOpenChange={(next) => { if (!next && !applying) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby="software-update-description"
          onEscapeKeyDown={(event) => { if (applying) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (applying) event.preventDefault(); }}>
          <Dialog.Title className={s.title}>
            <span className={s.titleIcon}><Sparkles size={16} /></span>
            {applying ? "正在应用更新" : ready ? "更新已准备好" : "Hermes 有更新可用"}
          </Dialog.Title>
          <Dialog.Description id="software-update-description" className={s.body}>
            {applying ? "正在完成版本切换，请稍候。" : updateImpact(state)}
          </Dialog.Description>
          {!applying && <>
            {state.targets.map((target) => <div key={target.kind} className={s.body}>
              <strong>{target.kind === "app" ? "Hermes" : target.kind === "runtime" ? "内核改进" : "界面改进"} · {target.version}</strong>
              {target.notes && <p>{target.notes.slice(0, 240)}</p>}
            </div>)}
            <div className={s.actions}>
              <button type="button" className={s.btn} onClick={close}>稍后提醒</button>
              <button type="button" className={s.btnPrimary} onClick={() => { close(); navigate("/updates"); }}>查看更新</button>
            </div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
