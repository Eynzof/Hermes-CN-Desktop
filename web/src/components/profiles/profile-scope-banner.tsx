import { Select } from "@hermes/shared-ui";
import { Users, X } from "lucide-react";
import s from "./profiles.module.css";

export interface ProfileScopeBannerProps {
  /** 当前管理范围（保证 ≠ 活跃档案，否则调用方不应渲染本组件）。 */
  scope: string;
  /** 可切换到的其它档案名（用于 banner 内的范围切换下拉）。 */
  profileNames: string[];
  /** null = 退出范围，回到跟随活跃档案。 */
  onSelect: (name: string | null) => void;
}

/**
 * 「正在管理档案 X」提示横幅。仅当管理范围 ≠ 活跃档案时显示。对齐官方 ProfileScopeBanner：
 * 提醒用户当前查看/修改作用于哪个档案，并提供切换/退出。我们只 scope 技能页，故文案聚焦技能。
 */
export function ProfileScopeBanner({ scope, profileNames, onSelect }: ProfileScopeBannerProps) {
  return (
    <div className={s.scopeBanner} role="status">
      <Users size={14} className={s.scopeIcon} />
      <span className={s.scopeText}>
        正在管理档案 <strong>{scope}</strong> —— 技能的查看与启停作用于该档案，不影响运行中的 dashboard。
      </span>
      <Select
        controlSize="sm"
        value={scope}
        fullWidth={false}
        onChange={(e) => onSelect(e.target.value || null)}
        className={s.scopeSelect}
        aria-label="切换管理范围"
      >
        {profileNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
      <button type="button" className={s.scopeExit} onClick={() => onSelect(null)}>
        <X size={13} /> 退出范围
      </button>
    </div>
  );
}
