import { useAtom } from "jotai";
import { Eye, EyeOff } from "lucide-react";
import { focusViewEnabledAtom } from "@/stores/ui";
import s from "./focus-view-toggle.module.css";

/**
 * Toggle for TUI focus-view parity.
 *
 * When enabled, consumers should suppress verbose tool-progress lines and
 * surface a status-bar segment. The flag is persisted via `focusViewEnabledAtom`.
 */
export function FocusViewToggle() {
  const [enabled, setEnabled] = useAtom(focusViewEnabledAtom);
  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      aria-pressed={enabled}
      title={enabled ? "退出焦点视图" : "进入焦点视图"}
      className={s.toggle}
    >
      {enabled ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
      <span>{enabled ? "焦点视图" : "焦点视图"}</span>
    </button>
  );
}
