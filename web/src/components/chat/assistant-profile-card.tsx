// 点击 Hermes 头像弹出的资料卡（微信联系人卡形态）：大头像 + 名称 +
// 身份副行、当前模型信息，底部「发消息 / 编辑人格 / 更换头像」快捷入口。
import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { MessageCircle, Ghost, ImageUp } from "lucide-react";
import { Popover } from "@hermes/shared-ui";
import { assistantAvatarEffectiveAtom, assistantDisplayNameAtom } from "@/stores/ui";
import s from "./assistant-profile-card.module.css";

interface AssistantProfileCardProps {
  /** 触发弹层的头像（作为 Popover.Trigger 渲染）。 */
  trigger: React.ReactNode;
  /** 当前会话使用的模型（可选，展示在信息区）。 */
  model?: string;
}

export function AssistantProfileCard({ trigger, model }: AssistantProfileCardProps) {
  const navigate = useNavigate();
  const displayName = useAtomValue(assistantDisplayNameAtom);
  const avatarUrl = useAtomValue(assistantAvatarEffectiveAtom);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.card}
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          role="dialog"
          aria-label={`${displayName} 资料卡`}
        >
          <div className={s.head}>
            <img className={s.bigAvatar} src={avatarUrl} alt={`${displayName} 头像`} />
            <div className={s.headText}>
              <div className={s.name}>{displayName}</div>
              <div className={s.sub}>爱为何物?</div>
            </div>
          </div>

          {model ? (
            <>
              <div className={s.divider} />
              <div className={s.infoRow}>
                <span className={s.infoLabel}>模型</span>
                <span className={s.infoValue}>{model}</span>
              </div>
            </>
          ) : null}

          <div className={s.divider} />
          <div className={s.actions}>
            <button type="button" className={s.action} onClick={() => navigate("/")}>
              <MessageCircle size={20} aria-hidden />
              <span>发消息</span>
            </button>
            <button type="button" className={s.action} onClick={() => navigate("/soul")}>
              <Ghost size={20} aria-hidden />
              <span>编辑人格</span>
            </button>
            <button type="button" className={s.action} onClick={() => navigate("/common")}>
              <ImageUp size={20} aria-hidden />
              <span>更换头像</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
