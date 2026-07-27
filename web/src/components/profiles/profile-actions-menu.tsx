import { useRef, useState } from "react";
import { DropdownMenu } from "@hermes/shared-ui";
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
 * 单个档案的 ⋯ 动作菜单（自带 DropdownMenu 触发器）。对齐官方桌面端 ProfileActionsMenu：
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
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setCopyState("idle");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={s.menuTrigger}
          aria-label={`${profile.name} 的操作`}
        >
          <MoreVertical size={15} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={s.menu}
          align="end"
          side="bottom"
          sideOffset={4}
        >
          <DropdownMenu.Item asChild onSelect={onSetActive} disabled={isActive}>
            <button
              type="button"
              disabled={isActive}
            >
              <Check size={13} /> 设为默认
            </button>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className={s.menuSep} />

          <DropdownMenu.Item asChild onSelect={onEditModel}>
            <button type="button">
              <Cpu size={13} /> 改模型
            </button>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild onSelect={onEditDescription}>
            <button type="button">
              <AlignLeft size={13} /> 改描述
            </button>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild onSelect={onEditSoul}>
            <button type="button">
              <ScrollText size={13} /> 编辑 SOUL.md
            </button>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild onSelect={onManageSkills}>
            <button type="button">
              <Package size={13} /> 管理技能
            </button>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            asChild
            onSelect={(event) => {
              event.preventDefault();
              void handleCopyCommand();
            }}
          >
            <button
              type="button"
              className={copyState === "copied" ? s.menuItemCopied : undefined}
            >
              <Terminal size={13} />
              {copyState === "copied"
                ? "已复制"
                : copyState === "error"
                  ? "复制失败"
                  : "复制 CLI 命令"}
            </button>
          </DropdownMenu.Item>

          {!profile.is_default && (
            <>
              <DropdownMenu.Separator className={s.menuSep} />
              <DropdownMenu.Item asChild onSelect={onRename}>
                <button type="button">
                  <Pencil size={13} /> 重命名
                </button>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild onSelect={onDelete} disabled={isActive}>
                <button
                  type="button"
                  data-tone="danger"
                  disabled={isActive}
                  title={isActive ? "切到别的档案后才能删" : undefined}
                >
                  <Trash2 size={13} /> 删除
                </button>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
