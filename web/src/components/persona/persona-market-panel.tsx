import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ExternalLink, Search, Sparkles, X } from "lucide-react";
import { Button, Dialog } from "@hermes/shared-ui";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import {
  filterPersonaMarket,
  loadPersonaPrompt,
  personaMarketCategories,
  personaMarketItems,
  personaMarketSource,
  type PersonaMarketItem,
} from "@/lib/persona-market";
import s from "./persona-market-panel.module.css";

const PAGE_SIZE = 24;

interface PersonaMarketPanelProps {
  profile: string;
  currentSoul: string;
  dirty: boolean;
  applying: boolean;
  onApply(prompt: string, persona: PersonaMarketItem): Promise<void>;
}

export function PersonaMarketPanel({
  profile,
  currentSoul,
  dirty,
  applying,
  onApply,
}: PersonaMarketPanelProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<PersonaMarketItem | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const filtered = useMemo(() => filterPersonaMarket(query, category), [query, category]);
  const visible = filtered.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, category]);

  useEffect(() => {
    if (!selected) {
      setPrompt("");
      setDialogError(null);
      return;
    }
    let cancelled = false;
    setLoadingPrompt(true);
    setDialogError(null);
    void loadPersonaPrompt(selected.id)
      .then((content) => {
        if (!cancelled) setPrompt(content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingPrompt(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const handleApply = async () => {
    if (!selected || !prompt || applying) return;
    if ((currentSoul.trim() || dirty) && !window.confirm(
      `将「${selected.name}」应用到档案「${profile}」？\n\n当前 SOUL.md${dirty ? "及未保存修改" : ""}将被替换。`,
    )) return;

    setDialogError(null);
    try {
      await onApply(prompt, selected);
      setAppliedId(selected.id);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    }
  };

  const openPersona = (persona: PersonaMarketItem) => {
    setPrompt("");
    setLoadingPrompt(true);
    setDialogError(null);
    setSelected(persona);
  };

  return (
    <div className={s.market}>
      <div className={s.marketIntro}>
        <div>
          <span className={s.eyebrow}>内置人格市场</span>
          <h2>为 Hermes 选择一位专业搭档</h2>
          <p>
            215 个中文专业人格已经适配 SOUL.md。选择角色、查看完整提示词，然后直接应用到当前档案。
          </p>
        </div>
        <div className={s.marketCount}>
          <strong>{personaMarketItems.length}</strong>
          <span>个人格</span>
        </div>
      </div>

      <div className={s.filters}>
        <label className={s.searchBox}>
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索角色、能力或关键词"
            aria-label="搜索人格"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
              <X size={14} />
            </button>
          )}
        </label>
        <label className={s.categorySelect}>
          <span>领域</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">全部领域</option>
            {personaMarketCategories.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className={s.resultBar}>
        <span>找到 {filtered.length} 个匹配人格</span>
        {(query || category !== "all") && (
          <button type="button" onClick={() => { setQuery(""); setCategory("all"); }}>
            重置筛选
          </button>
        )}
      </div>

      {visible.length ? (
        <div className={s.grid}>
          {visible.map((persona) => (
            <button
              type="button"
              key={persona.id}
              className={s.card}
              onClick={() => openPersona(persona)}
            >
              <span className={s.emoji} aria-hidden="true">{persona.emoji}</span>
              <span className={s.cardBody}>
                <span className={s.cardMeta}>{persona.categoryLabel}</span>
                <strong>{persona.name}</strong>
                <span className={s.description}>{persona.description}</span>
              </span>
              <span className={s.cardArrow} aria-hidden="true"><ChevronRight size={15} /></span>
            </button>
          ))}
        </div>
      ) : (
        <div className={s.empty}>没有匹配的人格，换个关键词试试。</div>
      )}

      {visibleCount < filtered.length && (
        <div className={s.loadMore}>
          <Button type="button" variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
            查看更多 · 还剩 {filtered.length - visibleCount} 个
          </Button>
        </div>
      )}

      <div className={s.attribution}>
        <span>提示词源自 MIT 许可的 Agency Agents，并采用社区中文译本。</span>
        <a href={personaMarketSource.upstreamRepository} target="_blank" rel="noreferrer">
          官方项目 <ExternalLink size={12} />
        </a>
        <a href={personaMarketSource.translationRepository} target="_blank" rel="noreferrer">
          中文译本 <ExternalLink size={12} />
        </a>
      </div>

      <Dialog.Root open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dialog} aria-describedby="persona-detail-description">
            {selected && (
              <>
                <header className={s.dialogHead}>
                  <span className={s.dialogEmoji} aria-hidden="true">{selected.emoji}</span>
                  <div>
                    <span>{selected.categoryLabel}</span>
                    <Dialog.Title>{selected.name}</Dialog.Title>
                    <Dialog.Description id="persona-detail-description">
                      {selected.description}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button type="button" className={s.closeButton} aria-label="关闭人格详情"><X size={17} /></button>
                  </Dialog.Close>
                </header>

                <div className={s.promptMeta}>
                  <span><Sparkles size={13} /> 完整中文提示词</span>
                  <span>{selected.characterCount.toLocaleString()} 字符</span>
                </div>
                <div className={s.promptPreview}>
                  {loadingPrompt ? (
                    <div className={s.promptState}>正在载入提示词…</div>
                  ) : prompt ? (
                    <MarkdownText text={prompt} />
                  ) : (
                    <div className={s.promptState}>无法载入提示词</div>
                  )}
                </div>

                {dialogError && <div className={s.dialogError}>{dialogError}</div>}
                {appliedId === selected.id && (
                  <div className={s.applied}><Check size={14} /> 已应用到档案 {profile}</div>
                )}

                <footer className={s.dialogFooter}>
                  <span>应用后会替换当前档案的 SOUL.md</span>
                  <Dialog.Close asChild><Button type="button" variant="outline">取消</Button></Dialog.Close>
                  <Button
                    type="button"
                    variant="solid"
                    tone="accent"
                    disabled={!prompt || loadingPrompt || applying}
                    onClick={() => void handleApply()}
                  >
                    <Sparkles size={14} />
                    {applying ? "应用中…" : appliedId === selected.id ? "再次应用" : "立即应用"}
                  </Button>
                </footer>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
