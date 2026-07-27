import { useState } from "react";
import { Brain, Check } from "lucide-react";
import { DropdownMenu } from "@hermes/shared-ui";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SHORT_LABELS,
  type ReasoningEffort,
} from "@/lib/reasoning-effort";
import s from "./reasoning-effort-menu.module.css";

export interface ReasoningEffortMenuProps {
  /** 当前思考强度；null 表示配置里未显式设置（后端回落到默认档）。 */
  value: ReasoningEffort | null;
  onSelect: (effort: ReasoningEffort) => void | Promise<void>;
  disabled?: boolean;
}

/**
 * 工具栏里的「思考强度」入口：紧贴模型选择按钮，展示当前会话的思考强度，
 * 点开后可在 关闭/最小/低/中/高/极高 之间切换。选择后通过网关
 * `config.set`（key="reasoning"）落到 config.yaml 并即时作用于当前会话，
 * 下一轮对话生效。
 */
export function ReasoningEffortMenu({ value, onSelect, disabled }: ReasoningEffortMenuProps) {
  const [open, setOpen] = useState(false);

  const thinkingOn = value !== null && value !== "none";
  // trigger 副标题：关闭 → "关闭"；已设置 → 档位；未设置 → "默认(中)"。
  const triggerHint =
    value === "none"
      ? REASONING_EFFORT_SHORT_LABELS.none
      : value
        ? REASONING_EFFORT_SHORT_LABELS[value]
        : `默认·${REASONING_EFFORT_SHORT_LABELS[DEFAULT_REASONING_EFFORT]}`;
  const triggerTitle = value
    ? `思考强度：${REASONING_EFFORT_LABELS[value]}`
    : `思考强度未设置，当前按默认「${REASONING_EFFORT_LABELS[DEFAULT_REASONING_EFFORT]}」运行`;

  const handleSelect = (effort: ReasoningEffort) => {
    setOpen(false);
    void onSelect(effort);
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={s.trigger}
          disabled={disabled}
          data-active={thinkingOn || open ? "true" : undefined}
          data-state={open ? "open" : undefined}
          title={triggerTitle}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Brain className={s.triggerIcon} aria-hidden="true" />
          <span>思考</span>
          <small>{triggerHint}</small>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={s.menu} side="top" align="start">
          <div className={s.menuTitle}>思考强度</div>
          <DropdownMenu.RadioGroup
            className={s.menuList}
            value={value ?? ""}
            onValueChange={(effort) => handleSelect(effort as ReasoningEffort)}
            aria-label="思考强度"
          >
            {REASONING_EFFORTS.map((effort) => {
              const isActive = effort === value;
              return (
                <DropdownMenu.RadioItem
                  key={effort}
                  value={effort}
                  className={s.menuItem}
                  data-active={isActive ? "true" : undefined}
                >
                  <span className={s.menuItemLabel}>{REASONING_EFFORT_LABELS[effort]}</span>
                  <DropdownMenu.ItemIndicator asChild>
                    <Check className={s.menuCheck} aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          <div className={s.menuFoot}>
            {thinkingOn
              ? "模型会进行推理；强度越高越慢、越耗 Token。"
              : value === "none"
                ? "已关闭推理，响应更快、更省 Token。"
                : `未设置时默认按「${REASONING_EFFORT_LABELS[DEFAULT_REASONING_EFFORT]}」运行。`}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
