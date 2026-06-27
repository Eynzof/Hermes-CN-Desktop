import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@hermes/shared-ui";
import { Plus, Wand2 } from "lucide-react";
import type { ProfileSummary } from "@hermes/protocol";
import {
  useActiveProfile,
  useProfiles,
  useProfileSetupCommand,
  useSetActiveProfile,
} from "@/hooks/use-profiles";
import { runtime } from "@/lib/runtime";
import {
  ActiveCurrentBanner,
  ProfileCard,
  ProfileCreateDialog,
  ProfileDeleteDialog,
  ProfileDescriptionDialog,
  ProfileModelDialog,
  ProfileRenameDialog,
  ProfileSoulDialog,
} from "@/components/profiles";
import { SectionShell } from "./section-shell";
import s from "./profiles.module.css";

type EditorKind = "create" | "rename" | "model" | "description" | "soul" | "delete";
type Editor = { kind: EditorKind; profile?: ProfileSummary };

export function ProfilesRoute() {
  const navigate = useNavigate();
  const profilesQuery = useProfiles();
  const activeQuery = useActiveProfile();
  const setActive = useSetActiveProfile();
  const setupCmd = useProfileSetupCommand();

  const [editor, setEditor] = useState<Editor | null>(null);
  const [restartHint, setRestartHint] = useState<string | null>(null);

  const profiles = profilesQuery.data ?? [];
  const active = activeQuery.data?.active ?? "default";
  const current = activeQuery.data?.current ?? active;
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
        if (result.mode === "web-sticky") setRestartHint(name);
      },
    });
  };

  const closeEditor = () => setEditor(null);
  const open = (kind: EditorKind, profile?: ProfileSummary) => () =>
    setEditor({ kind, profile });

  return (
    <SectionShell
      title="档案"
      sub={sub}
      right={
        !isError && !isLoading ? (
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button
              variant="outline"
              size="sm"
              leadingIcon={<Wand2 size={14} />}
              onClick={() => navigate("/profiles/new")}
            >
              Build 向导
            </Button>
            <Button
              variant="solid"
              tone="accent"
              size="sm"
              leadingIcon={<Plus size={14} />}
              onClick={open("create")}
            >
              新建档案
            </Button>
          </span>
        ) : undefined
      }
    >
      <p className={s.desc}>
        档案（profile）是 Hermes Agent 的独立环境（独立的 config / .env / SOUL.md /
        sessions / skills / memory）。每个档案有自己的 sticky 标记，新 hermes 进程启动时会读它决定加载哪个档案。
      </p>

      {runtime.platform === "electron" ? (
        <div className={s.warning}>
          <strong>切换会自动重启 dashboard 子进程。</strong>
          <span>
            桌面端 own 着 dashboard 进程，切换档案会自动 stop + 用新 HERMES_HOME 重新 spawn（约
            20-30 秒）。期间会话和 gateway 短暂断开，重启完成后自动连回新档案的数据。
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

      {!isError && !isLoading && <ActiveCurrentBanner active={active} current={current} />}

      {restartHint && (
        <div className={s.restartHint}>
          <strong>
            已设档案 <code>{restartHint}</code> 为默认。
          </strong>
          <span>下次 hermes 启动会用它。在终端重启 dashboard 后刷新此页面即可看到新档案的数据。</span>
          <button
            type="button"
            onClick={() => setRestartHint(null)}
            className={s.restartDismiss}
          >
            知道了
          </button>
        </div>
      )}

      {isError ? (
        <div className={s.errorState}>
          <strong>无法读取档案列表。</strong>
          <p>
            {errorObj instanceof Error ? errorObj.message : "未知错误"}。常见原因：dashboard 没启动，或 hermes 还没装 hermes-agent-cn fork（<code>/api/profiles/active</code> 是 fork P-008 加的）。
          </p>
        </div>
      ) : isLoading ? (
        <div className={s.emptyState}>加载中…</div>
      ) : profiles.length === 0 ? (
        <div className={s.emptyState}>
          一个档案都没有，连 default 都没有？这通常是 hermes 刚装还没初始化。运行{" "}
          <code>hermes setup</code> 引导一次。
        </div>
      ) : (
        <div className={s.grid}>
          {profiles.map((p) => (
            <ProfileCard
              key={p.name}
              profile={p}
              isActive={p.name === active}
              onSetActive={() => handleSetActive(p.name)}
              onEditModel={open("model", p)}
              onEditDescription={open("description", p)}
              onEditSoul={open("soul", p)}
              onManageSkills={() =>
                navigate(`/skills?profile=${encodeURIComponent(p.name)}`)
              }
              onRename={open("rename", p)}
              onDelete={open("delete", p)}
              fetchSetupCommand={(name) => setupCmd.mutateAsync(name)}
            />
          ))}
        </div>
      )}

      {editor?.kind === "create" && (
        <ProfileCreateDialog profiles={profiles} onClose={closeEditor} />
      )}
      {editor?.kind === "rename" && editor.profile && (
        <ProfileRenameDialog
          profile={editor.profile}
          existingNames={profiles.map((p) => p.name)}
          onClose={closeEditor}
        />
      )}
      {editor?.kind === "model" && editor.profile && (
        <ProfileModelDialog profile={editor.profile} onClose={closeEditor} />
      )}
      {editor?.kind === "description" && editor.profile && (
        <ProfileDescriptionDialog profile={editor.profile} onClose={closeEditor} />
      )}
      {editor?.kind === "soul" && editor.profile && (
        <ProfileSoulDialog profile={editor.profile} onClose={closeEditor} />
      )}
      {editor?.kind === "delete" && editor.profile && (
        <ProfileDeleteDialog profile={editor.profile} onClose={closeEditor} />
      )}
    </SectionShell>
  );
}
