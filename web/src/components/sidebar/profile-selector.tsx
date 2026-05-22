import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Popover } from "@hermes/shared-ui";
import {
  useActiveProfileName,
  useProfiles,
  useSetActiveProfile,
} from "@/hooks/use-profiles";
import s from "./profile-selector.module.css";

export function ProfileSelector() {
  const navigate = useNavigate();
  const profilesQuery = useProfiles();
  const active = useActiveProfileName();
  const setActive = useSetActiveProfile();
  const [open, setOpen] = useState(false);
  const [restartHint, setRestartHint] = useState<string | null>(null);

  const profiles = profilesQuery.data ?? [];
  const isLoading = profilesQuery.isLoading;
  const isError = profilesQuery.isError;

  const handlePick = (name: string) => {
    if (name === active) {
      setOpen(false);
      return;
    }
    setActive.mutate(name, {
      onSuccess: (result) => {
        // Electron mode：dashboard 已经重启，切换是即时生效的，不需要提示用户
        // 重启。Web mode 下才需要提示走终端。
        if (result.mode === "web-sticky") {
          setRestartHint(name);
        }
        setOpen(false);
      },
    });
  };

  const handleManage = () => {
    setOpen(false);
    navigate("/profiles");
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={s.trigger}
            disabled={isError}
            data-state={open ? "open" : undefined}
            title={
              isError
                ? "无法读取档案（dashboard 离线或没装 hermes-agent-cn fork）"
                : "当前档案 · 点击切换"
            }
          >
            <span className={s.triggerLabel}>档案</span>
            <span className={s.triggerName}>
              {isError ? "未接入" : active}
            </span>
            <ChevronsUpDown size={13} className={s.triggerChevron} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={s.menu} side="bottom" align="start">
            <div className={s.menuTitle}>切换档案</div>
            {isLoading ? (
              <div className={s.menuEmpty}>加载中…</div>
            ) : profiles.length === 0 ? (
              <div className={s.menuEmpty}>没有可用的档案</div>
            ) : (
              profiles.map((p) => {
                const isActive = p.name === active;
                return (
                  <button
                    key={p.name}
                    type="button"
                    className={s.menuItem}
                    data-active={isActive ? "true" : undefined}
                    onClick={() => handlePick(p.name)}
                    disabled={setActive.isPending}
                  >
                    <span className={s.menuItemName}>{p.name}</span>
                    {p.is_default && (
                      <span className={s.menuItemBadge}>default</span>
                    )}
                    {isActive && <Check size={13} className={s.menuCheck} />}
                  </button>
                );
              })
            )}
            <div className={s.menuFoot}>
              <button
                type="button"
                className={s.menuFootLink}
                onClick={handleManage}
              >
                管理档案…
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {restartHint && (
        <div className={s.restartHint}>
          <div className={s.restartHintBody}>
            已切到 <strong>{restartHint}</strong>。
            重启 dashboard 后才会真正加载新档案的 config / sessions。
          </div>
          <button
            type="button"
            className={s.restartHintDismiss}
            onClick={() => setRestartHint(null)}
            aria-label="关闭提示"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </>
  );
}
