import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Eye, FileText, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { SOUL_CHAR_LIMIT, SOUL_TEMPLATE, useSaveSoul, useSoul } from "@/hooks/use-soul";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import settings from "./settings.module.css";
import s from "./soul.module.css";

export function SoulRoute() {
  const profile = useActiveProfileName();
  const soulQuery = useSoul();
  const saveSoul = useSaveSoul();

  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
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

  const isEmpty = text.trim().length === 0;
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

  const handleInsertTemplate = () => {
    if (!isEmpty) return;
    setText(SOUL_TEMPLATE);
    setDirty(true);
    setMode("edit");
  };

  const right = (
    <div className={s.headRight}>
      <span className={s.profileChip} title="当前档案">
        {profile}
      </span>
      <Button
        type="button"
        variant="outline"
        onClick={() => void soulQuery.refetch()}
        disabled={soulQuery.isFetching}
      >
        <RefreshCw size={14} />
        {soulQuery.isFetching ? "刷新中" : "刷新"}
      </Button>
    </div>
  );

  return (
    <SectionShell title="灵魂" sub="SOUL.md · 智能体的核心人格（系统提示词第一身份）" right={right}>
      <SettingsHero
        ok={!errorMessage}
        icon={<FileText size={24} />}
        eyebrow="Hermes Agent 灵魂设定"
        title="当前档案的核心人格"
        description={(
          <>
            灵魂（SOUL.md）会被原样注入系统提示词的第一块，定义「这个智能体是谁、怎么说话」。这里编辑的是当前档案 <strong>{profile}</strong> 的灵魂；切换档案请前往{" "}
            <Link to="/profiles" className={s.inlineLink}>档案</Link> 页。
          </>
        )}
        badge={<span className={settings.statusBadge} data-on={!dirty}>{dirty ? "未保存" : "已同步"}</span>}
      />
      {soulQuery.isLoading ? (
        <div className={s.emptyState}>加载灵魂中…</div>
      ) : (
        <div className={s.soulPage}>
          {errorMessage && <div className={s.errorState}>{errorMessage}</div>}

          <section className={s.panel}>
            <div className={s.panelHead}>
              <div>
                <strong>核心人格 · SOUL.md</strong>
                <span>
                  {data && !data.exists
                    ? "尚未创建，保存后将在当前档案生成 SOUL.md"
                    : "原样注入系统提示词第一块，定义智能体的核心身份与语气"}
                </span>
              </div>
              <div className={s.headActions}>
                {savedFlash && <span className={s.saved}>已保存</span>}
                <div className={s.segmented} role="tablist" aria-label="编辑或预览">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "edit"}
                    data-active={mode === "edit" ? "true" : undefined}
                    onClick={() => setMode("edit")}
                  >
                    <Pencil size={13} /> 编辑
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "preview"}
                    data-active={mode === "preview" ? "true" : undefined}
                    onClick={() => setMode("preview")}
                  >
                    <Eye size={13} /> 预览
                  </button>
                </div>
              </div>
            </div>

            <div className={s.toolbar}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleInsertTemplate}
                disabled={!isEmpty}
                title={isEmpty ? "插入结构化人格模板" : "仅在内容为空时可用"}
              >
                <FileText size={13} /> 插入模板
              </Button>
              <span className={s.toolbarHint}>建议分节：人格 / 风格 / 避免 / 技术取向</span>
            </div>

            <div className={s.editorBody}>
              {mode === "edit" ? (
                <textarea
                  className={s.textarea}
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setDirty(true);
                  }}
                  placeholder={"# 人格\n你是一个务实、直接、有判断力的助手……"}
                  spellCheck={false}
                />
              ) : (
                <div className={s.preview}>
                  {text.trim() ? (
                    <MarkdownText text={text} />
                  ) : (
                    <div className={s.previewEmpty}>暂无内容可预览</div>
                  )}
                </div>
              )}
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
                onClick={handleSave}
                disabled={!dirty || saveSoul.isPending}
              >
                {saveSoul.isPending ? "保存中…" : "保存灵魂"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </SectionShell>
  );
}
