import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Pencil, RefreshCw, Sparkles, Store, UserRound } from "lucide-react";
import { Button, LoadingState } from "@hermes/shared-ui";
import { PersonaMarketPanel } from "@/components/persona/persona-market-panel";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { SOUL_CHAR_LIMIT, useSaveSoul, useSoul } from "@/hooks/use-soul";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import settings from "./settings.module.css";
import s from "./soul.module.css";

export const HERMES_PERSONA_TAB_LABEL = "Hermes 人格";

interface HermesPersonaEditorProps {
  exists: boolean;
  text: string;
  dirty: boolean;
  over: boolean;
  saving: boolean;
  saved: boolean;
  onTextChange(value: string): void;
  onSave(): void;
}

export function HermesPersonaEditor({
  exists,
  text,
  dirty,
  over,
  saving,
  saved,
  onTextChange,
  onSave,
}: HermesPersonaEditorProps) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <div>
          <strong>核心人格 · SOUL.md</strong>
          <span>
            {exists
              ? "直接编辑 Hermes 的核心身份、判断方式与沟通风格"
              : "尚未创建，保存后将在当前档案生成 SOUL.md"}
          </span>
        </div>
        <div className={s.headActions}>
          {saved && <span className={s.saved}>已保存</span>}
          <span className={s.editMode}><Pencil size={12} /> 编辑</span>
        </div>
      </div>

      <div className={s.editorBody}>
        <textarea
          className={s.textarea}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={"# 人格\n你是一个务实、直接、有判断力的助手……"}
          spellCheck={false}
        />
      </div>

      <div className={s.footer}>
        <span className={s.count} data-over={over ? "true" : undefined}>
          {text.length.toLocaleString()} / {SOUL_CHAR_LIMIT.toLocaleString()} 字符
          {over ? " · 超出部分将在注入时截断" : ""}
        </span>
        <Button
          type="button"
          variant="solid"
          tone="accent"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={!dirty}
        >
          保存人格
        </Button>
      </div>
    </section>
  );
}

export function SoulRoute() {
  const profile = useActiveProfileName();
  const soulQuery = useSoul();
  const saveSoul = useSaveSoul();

  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState<"market" | "custom">("market");
  const [savedFlash, setSavedFlash] = useState(false);

  const data = soulQuery.data;

  // 未脏时用后端值回填编辑器（首次加载 / 刷新 / 保存后失效重取）。
  useEffect(() => {
    if (!data || dirty) return;
    setText(data.content);
  }, [data, dirty]);

  // 切换档案时丢弃未保存的本地编辑，回到新档案的后端值。
  useEffect(() => {
    setDirty(false);
  }, [profile]);

  const over = text.length > SOUL_CHAR_LIMIT;
  const error = soulQuery.error || saveSoul.error;
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;

  const handleSave = () => {
    saveSoul.mutate(text, {
      onSuccess: () => {
        setDirty(false);
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 1600);
      },
    });
  };

  const handleApplyPersona = async (prompt: string) => {
    await saveSoul.mutateAsync(prompt);
    setText(prompt);
    setDirty(false);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2200);
  };

  const right = (
    <div className={s.headRight}>
      <span className={s.profileChip} title="当前档案">
        {profile}
      </span>
      <Button
        type="button"
        variant="outline"
        loading={soulQuery.isFetching}
        leadingIcon={<RefreshCw size={16} />}
        onClick={() => void soulQuery.refetch()}
      >
        刷新
      </Button>
    </div>
  );

  return (
    <SectionShell title="人格" sub="内置人格市场与 SOUL.md 自定义设定" right={right}>
      <SettingsHero
        ok={!errorMessage}
        icon={<Sparkles size={24} />}
        eyebrow="Hermes Agent 人格中心"
        title="选择专家人格，或者创造你自己的"
        description={(
          <>
            应用人格后，完整中文提示词会写入当前档案 <strong>{profile}</strong> 的 SOUL.md，并作为智能体的第一身份。切换档案请前往{" "}
            <Link to="/profiles" className={s.inlineLink}>档案</Link> 页。
          </>
        )}
        badge={(
          <span className={settings.statusBadge} data-on={!dirty && !errorMessage}>
            {errorMessage ? "读取失败" : savedFlash ? "人格已应用" : dirty ? "未保存" : "已同步"}
          </span>
        )}
      />
      {soulQuery.isLoading ? (
        <LoadingState variant="page" label="正在加载人格…" />
      ) : (
        <div className={s.soulPage}>
          {errorMessage && <div className={s.errorState}>{errorMessage}</div>}

          <div className={s.pageTabs} role="tablist" aria-label="人格市场或自定义人格">
            <button
              type="button"
              role="tab"
              aria-selected={page === "market"}
              data-active={page === "market" ? "true" : undefined}
              onClick={() => setPage("market")}
            >
              <Store size={16} /> 人格市场
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={page === "custom"}
              data-active={page === "custom" ? "true" : undefined}
              onClick={() => setPage("custom")}
            >
              <UserRound size={16} /> {HERMES_PERSONA_TAB_LABEL}
            </button>
          </div>

          {page === "market" ? (
            <PersonaMarketPanel
              profile={profile}
              currentSoul={text}
              dirty={dirty}
              applying={saveSoul.isPending}
              onApply={handleApplyPersona}
            />
          ) : (
            <HermesPersonaEditor
              exists={data?.exists ?? false}
              text={text}
              dirty={dirty}
              over={over}
              saving={saveSoul.isPending}
              saved={savedFlash}
              onTextChange={(value) => {
                setText(value);
                setDirty(true);
              }}
              onSave={handleSave}
            />
          )}
        </div>
      )}
    </SectionShell>
  );
}
