import { EmbeddedTerminal } from "@/components/console/embedded-terminal";
import s from "./preview-rail.module.css";

// Reuses the shared xterm widget. Mounting/unmounting with the tab means a
// fresh terminal each time the tab is opened, which is fine for the rail.
export function TerminalTab() {
  if (!window.hermesDesktop?.terminalStart) {
    return <div className={s.empty}>终端需要在桌面端中使用。</div>;
  }
  return <EmbeddedTerminal purpose="shell" className={s.terminalSurface} />;
}
