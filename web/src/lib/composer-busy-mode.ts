/**
 * Composer busy-mode control (TUI `/busy` parity).
 *
 * The original TUI supports three busy input modes:
 * - `interrupt` — Ctrl+C / Stop cancels the running turn.
 * - `queue` — new prompts are enqueued and run after the current turn.
 * - `steer` — new prompts are sent as steering messages to the running turn.
 */

export const COMPOSER_BUSY_MODES = ["interrupt", "queue", "steer"] as const;
export type ComposerBusyMode = (typeof COMPOSER_BUSY_MODES)[number];

export function normalizeBusyMode(value: unknown): ComposerBusyMode {
  return COMPOSER_BUSY_MODES.includes(value as ComposerBusyMode)
    ? (value as ComposerBusyMode)
    : "interrupt";
}

export function busyModeLabel(mode: ComposerBusyMode): string {
  switch (mode) {
    case "interrupt":
      return "中断";
    case "queue":
      return "排队";
    case "steer":
      return "引导";
    default:
      return mode;
  }
}

export function busyModeDescription(mode: ComposerBusyMode): string {
  switch (mode) {
    case "interrupt":
      return "新消息会中断当前回复";
    case "queue":
      return "新消息在当前回复结束后排队执行";
    case "steer":
      return "新消息作为引导发给正在运行的会话";
    default:
      return "";
  }
}
