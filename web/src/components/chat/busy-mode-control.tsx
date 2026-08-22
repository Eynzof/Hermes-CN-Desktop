import { useAtom } from "jotai";
import { Pause, Play, SendHorizonal, Square } from "lucide-react";
import { busyModeAtom } from "@/stores/ui";
import {
  busyModeDescription,
  busyModeLabel,
  COMPOSER_BUSY_MODES,
  type ComposerBusyMode,
} from "@/lib/composer-busy-mode";
import s from "./busy-mode-control.module.css";

const ICONS: Record<ComposerBusyMode, typeof Square> = {
  interrupt: Square,
  queue: Play,
  steer: SendHorizonal,
};

/**
 * Selector for the composer busy mode (TUI `/busy` parity).
 *
 * Controls how the composer behaves when a turn is already running:
 * - interrupt: stop the running turn and send the new prompt
 * - queue: enqueue the prompt for after the current turn
 * - steer: send the prompt as a steering message
 */
export function BusyModeControl() {
  const [mode, setMode] = useAtom(busyModeAtom);
  return (
    <div className={s.group} role="radiogroup" aria-label="忙碌模式">
      {COMPOSER_BUSY_MODES.map((value) => {
        const Icon = value === "queue" ? Pause : ICONS[value];
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={busyModeDescription(value)}
            onClick={() => setMode(value)}
            className={s.modeButton}
            data-active={active}
          >
            <Icon size={12} aria-hidden="true" />
            <span>{busyModeLabel(value)}</span>
          </button>
        );
      })}
    </div>
  );
}
