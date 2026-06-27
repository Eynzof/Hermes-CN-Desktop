import { Badge, StatusDot } from "@hermes/shared-ui";
import { Package } from "lucide-react";
import type { ProfileSummary } from "@hermes/protocol";
import { ProfileActionsMenu } from "./profile-actions-menu";
import s from "./profiles.module.css";

export interface ProfileCardProps {
  profile: ProfileSummary;
  isActive: boolean;
  onSetActive: () => void;
  onEditModel: () => void;
  onEditDescription: () => void;
  onEditSoul: () => void;
  onManageSkills: () => void;
  onRename: () => void;
  onDelete: () => void;
  fetchSetupCommand: (name: string) => Promise<string>;
}

/**
 * 单个档案卡片：名称 + 状态 badges（当前/默认/alias/.env/distribution）、gateway 运行
 * 状态点、描述（自动生成时带「待复核」标）、底部模型/技能/路径，以及 ⋯ 动作菜单。
 * 对齐官方桌面端 ProfilesPage 的卡片信息密度。
 */
export function ProfileCard({
  profile: p,
  isActive,
  onSetActive,
  onEditModel,
  onEditDescription,
  onEditSoul,
  onManageSkills,
  onRename,
  onDelete,
  fetchSetupCommand,
}: ProfileCardProps) {
  const distribution = p.distribution_name
    ? p.distribution_version
      ? `${p.distribution_name}@${p.distribution_version}`
      : p.distribution_name
    : null;

  return (
    <div className={s.card} data-active={isActive ? "true" : undefined}>
      <div className={s.cardHead}>
        <div className={s.cardHeadMain}>
          <span className={s.name} title={p.name}>
            {p.name}
          </span>
          {isActive && (
            <Badge tone="success" size="sm">
              当前
            </Badge>
          )}
          {p.is_default && (
            <Badge tone="neutral" size="sm">
              默认
            </Badge>
          )}
          {p.has_alias && (
            <Badge variant="outline" size="sm">
              alias
            </Badge>
          )}
          {p.has_env && (
            <Badge variant="outline" size="sm">
              .env
            </Badge>
          )}
          {distribution && (
            <Badge variant="outline" size="sm" title={p.distribution_source ?? undefined}>
              <Package size={10} /> {distribution}
            </Badge>
          )}
        </div>
        <ProfileActionsMenu
          profile={p}
          isActive={isActive}
          onSetActive={onSetActive}
          onEditModel={onEditModel}
          onEditDescription={onEditDescription}
          onEditSoul={onEditSoul}
          onManageSkills={onManageSkills}
          onRename={onRename}
          onDelete={onDelete}
          fetchSetupCommand={fetchSetupCommand}
        />
      </div>

      <span className={s.gatewayRow} data-running={p.gateway_running ? "true" : undefined}>
        <StatusDot tone={p.gateway_running ? "success" : "neutral"} size="sm" />
        {p.gateway_running ? "gateway 运行中" : "gateway 已停止"}
      </span>

      <div className={s.descRow}>
        {p.description ? (
          <span className={s.desc}>{p.description}</span>
        ) : (
          <span className={s.descMuted}>无描述</span>
        )}
        {p.description && p.description_auto && (
          <Badge tone="warning" variant="soft" size="sm" title="自动生成，建议人工复核">
            待复核
          </Badge>
        )}
      </div>

      <div className={s.cardFoot}>
        {p.model ? (
          <span>
            模型 <code>{p.model}</code>
            {p.provider ? ` · ${p.provider}` : ""}
          </span>
        ) : (
          <span>未配置 model</span>
        )}
        <span>{p.skill_count} 个技能</span>
        <span className={s.path} title={p.path}>
          {p.path}
        </span>
      </div>
    </div>
  );
}
