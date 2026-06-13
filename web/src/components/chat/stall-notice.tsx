import { AlertTriangle } from "lucide-react";
import { formatElapsedTimer } from "@/lib/format";
import s from "./stall-notice.module.css";

interface StallNoticeProps {
  /** Backend silence so far, in ms. */
  silenceMs: number;
  /** Interrupt the wedged turn (reuses the composer Stop → session.interrupt path). */
  onInterrupt: () => void;
  interrupting?: boolean;
}

/**
 * Shown when a running turn has received nothing from the backend for longer
 * than the stall threshold — the case the connection heartbeat can't see
 * (gateway alive, agent turn wedged on a dead provider call). Gives the user a
 * truthful "no response for Ns" signal and a one-click interrupt instead of a
 * timer that ticks up forever with no progress.
 */
export function StallNotice({ silenceMs, onInterrupt, interrupting = false }: StallNoticeProps) {
  return (
    <div className={s.notice} role="alert" aria-live="polite">
      <AlertTriangle className={s.icon} size={16} aria-hidden />
      <span className={s.text}>
        模型服务已 {formatElapsedTimer(silenceMs)} 无响应，可能已卡住。后端会尝试自动重连；如长时间无进展，可手动中断后重试。
      </span>
      <button
        type="button"
        className={s.action}
        onClick={onInterrupt}
        disabled={interrupting}
      >
        {interrupting ? "中断中…" : "中断"}
      </button>
    </div>
  );
}
