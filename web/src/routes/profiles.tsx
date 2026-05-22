import { useState } from "react";
import { Check } from "lucide-react";
import {
  useActiveProfile,
  useCreateProfile,
  useDeleteProfile,
  useProfiles,
  useSetActiveProfile,
} from "@/hooks/use-profiles";
import { runtime } from "@/lib/runtime";
import { SectionShell } from "./section-shell";
import s from "./profiles.module.css";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function ProfilesRoute() {
  const profilesQuery = useProfiles();
  const activeQuery = useActiveProfile();
  const setActive = useSetActiveProfile();
  const createProfile = useCreateProfile();
  const deleteProfile = useDeleteProfile();
  const [restartHint, setRestartHint] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [cloneFromDefault, setCloneFromDefault] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const profiles = profilesQuery.data ?? [];
  const active = activeQuery.data ?? "default";
  const isLoading = profilesQuery.isLoading || activeQuery.isLoading;
  const isError = profilesQuery.isError || activeQuery.isError;
  const errorObj = profilesQuery.error || activeQuery.error;

  const sub = isError
    ? "未接入"
    : profilesQuery.data
      ? `${profiles.length} 个档案 · 当前 ${active}`
      : isLoading
        ? "加载中…"
        : "—";

  const handleSetActive = (name: string) => {
    if (name === active) return;
    setActive.mutate(name, {
      onSuccess: (result) => {
        if (result.mode === "web-sticky") {
          setRestartHint(name);
        }
      },
    });
  };

  const handleCreate = () => {
    setCreateError(null);
    const name = newName.trim();
    if (!NAME_RE.test(name)) {
      setCreateError("只允许字母 / 数字 / - / _，以字母或数字开头，最长 32 字符");
      return;
    }
    if (profiles.some((p) => p.name === name)) {
      setCreateError("已存在同名档案");
      return;
    }
    createProfile.mutate(
      { name, clone_from_default: cloneFromDefault || undefined },
      {
        onSuccess: () => {
          setNewName("");
          setCloneFromDefault(false);
          setCreating(false);
        },
        onError: (err) => {
          setCreateError(err instanceof Error ? err.message : "创建失败");
        },
      },
    );
  };

  const handleDelete = (name: string) => {
    // 用 window.confirm 是保守选择——这页其它危险操作（重启 dashboard 提示）
    // 也是文字提示，没必要为单个删除操作引入 modal 组件依赖。
    const ok = window.confirm(
      `删除档案 "${name}"？\n\n这会删掉它的整个目录（config / .env / sessions / skills / memory / state.db 全部）。无法恢复。`,
    );
    if (!ok) return;
    deleteProfile.mutate(name);
  };

  return (
    <SectionShell title="档案" sub={sub}>
      <p className={s.desc}>
        档案（profile）是 Hermes Agent 的独立环境（独立的 config / .env / SOUL.md / sessions / skills / memory）。每个档案有自己的 sticky 标记，新 hermes 进程启动时会读它决定加载哪个档案。
      </p>

      {runtime.platform === "electron" ? (
        <div className={s.warning}>
          <strong>切换会自动重启 dashboard 子进程。</strong>
          <span>
            桌面端 own 着 dashboard 进程，切换档案会自动 stop + 用新 HERMES_HOME 重新 spawn（约 2-3 秒）。期间会话和 gateway 短暂断开，重启完成后自动连回新档案的数据。
          </span>
        </div>
      ) : (
        <div className={s.warning}>
          <strong>切换不会立即生效。</strong>
          <span>
            切换档案只更新 <code>~/.hermes/active_profile</code>。当前运行的 dashboard 进程已绑定旧档案，要让切换生效必须<strong>重启 dashboard</strong>（终端 <code>Ctrl+C</code>，再跑 <code>hermes dashboard --no-open</code>）。
          </span>
        </div>
      )}

      {restartHint && (
        <div className={s.restartHint}>
          <strong>已设档案 <code>{restartHint}</code> 为默认。</strong>
          <span>下次 hermes 启动会用它。在终端重启 dashboard 后刷新此页面即可看到新档案的数据。</span>
          <button type="button" onClick={() => setRestartHint(null)} className={s.restartDismiss}>
            知道了
          </button>
        </div>
      )}

      {!isError && !isLoading && (
        <div className={s.toolbar}>
          <button
            type="button"
            className={s.newBtn}
            onClick={() => {
              setCreating((v) => !v);
              setCreateError(null);
            }}
            disabled={createProfile.isPending}
          >
            {creating ? "取消" : "+ 新建档案"}
          </button>
        </div>
      )}

      {creating && (
        <div className={s.createCard}>
          <div className={s.createCardTitle}>新建档案</div>
          <div className={s.createForm}>
            <div className={s.fieldRow}>
              <label className={s.fieldLabel} htmlFor="profile-name-input">
                名称（字母 / 数字 / - / _）
              </label>
              <input
                id="profile-name-input"
                className={s.fieldInput}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例如 work / sandbox"
                autoFocus
                disabled={createProfile.isPending}
              />
            </div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>初始化方式</span>
              <div className={s.fieldRadios}>
                <label>
                  <input
                    type="radio"
                    name="profile-init"
                    checked={!cloneFromDefault}
                    onChange={() => setCloneFromDefault(false)}
                    disabled={createProfile.isPending}
                  />
                  空白（hermes setup 引导走一遍）
                </label>
                <label>
                  <input
                    type="radio"
                    name="profile-init"
                    checked={cloneFromDefault}
                    onChange={() => setCloneFromDefault(true)}
                    disabled={createProfile.isPending}
                  />
                  从 default 复制 config / .env
                </label>
              </div>
            </div>
            {createError && <div className={s.formError}>{createError}</div>}
            <div className={s.formActions}>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setCreateError(null);
                }}
                disabled={createProfile.isPending}
              >
                取消
              </button>
              <button
                type="button"
                className={s.formPrimary}
                onClick={handleCreate}
                disabled={createProfile.isPending || newName.trim().length === 0}
              >
                {createProfile.isPending ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isError ? (
        <div className={s.errorState}>
          <strong>无法读取档案列表。</strong>
          <p>
            {errorObj instanceof Error ? errorObj.message : "未知错误"}。常见原因：dashboard 没启动，或 hermes 还没装 hermes-agent-cn fork（`/api/profiles/active` 是 fork P-008 加的）。
          </p>
        </div>
      ) : isLoading ? (
        <div className={s.emptyState}>加载中…</div>
      ) : profiles.length === 0 ? (
        <div className={s.emptyState}>
          一个档案都没有，连 default 都没有？这通常是 hermes 刚装还没初始化。运行 <code>hermes setup</code> 引导一次。
        </div>
      ) : (
        <div className={s.list}>
          {profiles.map((p) => {
            const isActive = p.name === active;
            const isDeleting = deleteProfile.isPending && deleteProfile.variables === p.name;
            return (
              <div key={p.name} className={s.row} data-active={isActive ? "true" : undefined}>
                <div className={s.rowMain}>
                  <div className={s.rowHead}>
                    <span className={s.rowName}>{p.name}</span>
                    {p.is_default && <span className={s.tag}>default</span>}
                    {isActive && (
                      <span className={s.activeBadge}>
                        <Check size={11} />
                        当前默认
                      </span>
                    )}
                  </div>
                  <div className={s.rowMeta}>
                    {p.model ? (
                      <span className={s.metaCell}>
                        模型 <code>{p.model}</code>
                        {p.provider ? ` · ${p.provider}` : ""}
                      </span>
                    ) : (
                      <span className={s.metaCellMuted}>未配置 model</span>
                    )}
                    <span className={s.metaCell}>{p.skill_count} 个技能</span>
                    <span className={s.metaCell}>{p.has_env ? "有 .env" : "无 .env"}</span>
                  </div>
                </div>
                <div className={s.rowActions}>
                  {isActive ? (
                    <span className={s.actionPlaceholder}>—</span>
                  ) : (
                    <button
                      type="button"
                      className={s.actionBtn}
                      onClick={() => handleSetActive(p.name)}
                      disabled={setActive.isPending}
                    >
                      {setActive.isPending && setActive.variables === p.name ? "保存中…" : "设为默认"}
                    </button>
                  )}
                  {!p.is_default && (
                    <button
                      type="button"
                      className={s.deleteBtn}
                      onClick={() => handleDelete(p.name)}
                      disabled={isDeleting || isActive}
                      title={isActive ? "切到别的档案后才能删" : "删除此档案（含目录所有数据）"}
                    >
                      {isDeleting ? "删除中…" : "删除"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className={s.footnote}>
        重命名档案暂未在 UI 内提供 —— 用 CLI：<code>hermes profile rename &lt;old&gt; &lt;new&gt;</code>。
      </p>
    </SectionShell>
  );
}
