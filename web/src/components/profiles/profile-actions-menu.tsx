import { useRef, useState } from "react";
import { Popover } from "@hermes/shared-ui";
import {
  AlignLeft,
  Check,
  Cpu,
  MoreVertical,
  Package,
  Pencil,
  ScrollText,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ProfileSummary } from "@hermes/protocol";
import s from "./profiles.module.css";

export interface ProfileActionsMenuProps {
  profile: ProfileSummary;
  isActive: boolean;
  onSetActive: () => void;
  onEditModel: () => void;
  onEditDescription: () => void;
  onEditSoul: () => void;
  onManageSkills: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** 拉取「在终端配置此档案」的 shell 命令（点击「复制 CLI 命令」时调用）。 */
  fetchSetupCommand: (name: string) => Promise<string>;
}

/**
 * 单个档案的 ⋯ 动作菜单（自带 Popover 触发器）。对齐官方桌面端 ProfileActionsMenu：
 * 设为默认 / 改模型 / 改描述 / 编辑 SOUL / 复制 CLI 命令 / 重命名 / 删除。
 * default 档案不可重命名/删除；当前档案不可「设为默认」、且要切走后才能删。
 */
export function ProfileActionsMenu({
  profile,
  isActive,
  onSetActive,
  onEditModel,
  onEditDescription,
  onEditSoul,
  onManageSkills,
  onRename,
  onDelete,
  fetchSetupCommand,
}: ProfileActionsMenuProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);

  const handleCopyCommand = async () => {
    try {
      const cmd = await fetchSetupCommand(profile.name);
      await navigator.clipboard.writeText(cmd);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  };

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) setCopyState("idle");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.menuTrigger}
          aria-label={`${profile.name} 的操作`}
        >
          <MoreVertical size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.menu}
          align="end"
          side="bottom"
          sideOffset={4}
          role="menu"
        >
          <Popover.Close asChild>
            <button
              type="button"
              role="menuitem"
              onClick={onSetActive}
              disabled={isActive}
            >
              <Check size={13} /> 设为默认
            </button>
          </Popover.Close>

          <div className={s.menuSep} />

          <Popover.Close asChild>
            <button type="button" role="menuitem" onClick={onEditModel}>
              <Cpu size={13} /> 改模型
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" onClick={onEditDescription}>
              <AlignLeft size={13} /> 改描述
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" onClick={onEditSoul}>
              <ScrollText size={13} /> 编辑 SOUL.md
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" onClick={onManageSkills}>
              <Package size={13} /> 管理技能
            </button>
          </Popover.Close>
          {/* 不包 Popover.Close：保持菜单打开以便就地显示「已复制」反馈。 */}
          <button
            type="button"
            role="menuitem"
            onClick={handleCopyCommand}
            className={copyState === "copied" ? s.menuItemCopied : undefined}
          >
            <Terminal size={13} />
            {copyState === "copied"
              ? "已复制"
              : copyState === "error"
                ? "复制失败"
                : "复制 CLI 命令"}
          </button>

          {!profile.is_default && (
            <>
              <div className={s.menuSep} />
              <Popover.Close asChild>
                <button type="button" role="menuitem" onClick={onRename}>
                  <Pencil size={13} /> 重命名
                </button>
              </Popover.Close>
              <Popover.Close asChild>
                <button
                  type="button"
                  role="menuitem"
                  data-tone="danger"
                  onClick={onDelete}
                  disabled={isActive}
                  title={isActive ? "切到别的档案后才能删" : undefined}
                >
                  <Trash2 size={13} /> 删除
                </button>
              </Popover.Close>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
