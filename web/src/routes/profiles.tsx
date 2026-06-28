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
        档案是一套相互独立的环境，各自拥有配置、密钥、人格（SOUL.md）、会话、技能和记忆。
        启动时由当前档案决定加载哪一套数据。
      </p>

      {runtime.platform !== "web" ? (
        <div className={s.warning}>
          <strong>切换会自动重启内核。</strong>
          <span>
            切换档案时，桌面端会自动重启本机内核（约 20-30 秒）。期间连接会短暂断开，
            完成后自动连到新档案的数据。
          </span>
        </div>
      ) : (
        <div className={s.warning}>
          <strong>切换不会立即生效。</strong>
          <span>
            切换档案后，需要重启正在运行的 Hermes 才能生效（在终端按 <code>Ctrl+C</code> 停止，再重新运行 <code>hermes dashboard --no-open</code>）。
          </span>
        </div>
      )}

      {!isError && !isLoading && <ActiveCurrentBanner active={active} current={current} />}

      {restartHint && (
        <div className={s.restartHint}>
          <strong>
            已将档案 <code>{restartHint}</code> 设为默认。
          </strong>
          <span>下次启动时会使用它。重启 Hermes 后刷新本页即可看到新档案的数据。</span>
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
