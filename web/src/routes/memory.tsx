import { useEffect, useMemo, useState } from "react";
import { Brain, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  useAddMemoryEntry,
  useMemory,
  useRemoveMemoryEntry,
  useSaveUserProfile,
  useUpdateMemoryEntry,
} from "@/hooks/use-memory";
import { Button } from "@hermes/shared-ui";
import { memoryPageStats, formatMemoryPageStat } from "@/lib/memory-page-stats";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import settings from "./settings.module.css";
import s from "./memory.module.css";

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "未创建";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "刚刚更新";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CapacityBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct > 90 ? "err" : pct > 70 ? "warn" : "ok";
  return (
    <div className={s.capacity} data-tone={tone}>
      <div className={s.capacityHead}>
        <span>{label}</span>
        <span>{used.toLocaleString()} / {limit.toLocaleString()} 字符 · {pct}%</span>
      </div>
      <div className={s.capacityTrack}>
        <div className={s.capacityFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MemoryRoute() {
  const memoryQuery = useMemory();
  const [tab, setTab] = useState<"entries" | "profile">("entries");
  const addEntry = useAddMemoryEntry();
  const updateEntry = useUpdateMemoryEntry();
  const removeEntry = useRemoveMemoryEntry();
  const saveUser = useSaveUserProfile();
  const [showAdd, setShowAdd] = useState(false);
  const [newEntry, setNewEntry] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [userContent, setUserContent] = useState("");
  const [userDirty, setUserDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const data = memoryQuery.data;

  useEffect(() => {
    if (!data || userDirty) return;
    setUserContent(data.user.content);
  }, [data, userDirty]);

  const stats = useMemo(() => data ? memoryPageStats(data) : [], [data]);

  const isLoading = memoryQuery.isLoading;
  const error = memoryQuery.error || addEntry.error || updateEntry.error || saveUser.error;

  const handleAdd = () => {
    const content = newEntry.trim();
    if (!content) return;
    addEntry.mutate(content, {
      onSuccess: () => {
        setNewEntry("");
        setShowAdd(false);
      },
    });
  };

  const handleSaveEdit = () => {
    if (editingIndex === null) return;
    updateEntry.mutate({ index: editingIndex, content: editContent }, {
      onSuccess: () => {
        setEditingIndex(null);
        setEditContent("");
      },
    });
  };

  const handleSaveUser = () => {
    saveUser.mutate(userContent, {
      onSuccess: () => {
        setUserDirty(false);
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 1600);
      },
    });
  };

  const right = (
    <Button type="button" variant="outline" onClick={() => void memoryQuery.refetch()} disabled={memoryQuery.isFetching}>
      <RefreshCw size={14} />
      {memoryQuery.isFetching ? "刷新中" : "刷新"}
    </Button>
  );

  return (
    <SectionShell title="内置记忆" sub="MEMORY.md / USER.md" right={right}>
      <SettingsHero
        ok={!memoryQuery.isError}
        icon={<Brain size={24} />}
        eyebrow="Hermes Agent 内置记忆"
        title="内置记忆与用户画像"
        description="这里管理当前档案中的 MEMORY.md 与 USER.md。内置记忆用于保存跨会话事实，用户画像用于描述你的偏好、角色和沟通方式。"
        badge={(
          <span className={settings.statusBadge} data-on={!memoryQuery.isError}>
            {isLoading ? "读取中" : data ? `${data.memory.entries.length} 条记忆` : "记忆"}
          </span>
        )}
      />
      {memoryQuery.isError && !data ? (
        <div className={s.memoryPage}>
          <div className={s.errorState}>无法读取记忆：{errorMessage(memoryQuery.error)}</div>
          <Button type="button" variant="outline" onClick={() => void memoryQuery.refetch()}>重试</Button>
        </div>
      ) : isLoading || !data ? (
        <div className={s.emptyState}>加载记忆中…</div>
      ) : (
        <div className={s.memoryPage}>
          <div className={s.statsGrid}>
            {stats.map((item) => (
              <div key={item.label} className={s.statCard}>
                <span>{formatMemoryPageStat(item.value)}</span>
                <small>{item.label}</small>
              </div>
            ))}
          </div>

          <div className={s.capacityGrid}>
            <CapacityBar label="记忆" used={data.memory.charCount} limit={data.memory.charLimit} />
            <CapacityBar label="用户画像" used={data.user.charCount} limit={data.user.charLimit} />
          </div>

          <div className={s.tabs}>
            <button type="button" data-active={tab === "entries" ? "true" : undefined} onClick={() => setTab("entries")}>
              本地记忆 <span>{timeAgo(data.memory.lastModified)}</span>
            </button>
            <button type="button" data-active={tab === "profile" ? "true" : undefined} onClick={() => setTab("profile")}>
              用户画像 <span>{timeAgo(data.user.lastModified)}</span>
            </button>
          </div>

          {error && <div className={s.errorState}>{errorMessage(error)}</div>}

          {tab === "entries" && (
            <section className={s.panel}>
              <div className={s.panelHead}>
                <div>
                  <strong>{data.memory.entries.length} 条记忆</strong>
                  <span>写入当前档案的 memories/MEMORY.md</span>
                </div>
                <Button type="button" variant="solid" tone="accent" size="sm" onClick={() => setShowAdd((v) => !v)}>
                  <Plus size={14} /> 添加记忆
                </Button>
              </div>

              {showAdd && (
                <div className={s.formCard}>
                  <textarea
                    value={newEntry}
                    onChange={(event) => setNewEntry(event.target.value)}
                    placeholder="例如：用户偏好使用 TypeScript，修改前先跑 typecheck。"
                    rows={3}
                    autoFocus
                  />
                  <div className={s.formActions}>
                    <span>{newEntry.length} 字符</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setShowAdd(false); setNewEntry(""); }}>取消</Button>
                    <Button type="button" variant="solid" tone="accent" size="sm" onClick={handleAdd} disabled={!newEntry.trim() || addEntry.isPending}>保存</Button>
                  </div>
                </div>
              )}

              {data.memory.entries.length === 0 ? (
                <div className={s.emptyState}>
                  <Brain size={18} />
                  暂无记忆。Hermes 会在聊天时自动沉淀重要事实，你也可以手动添加。
                </div>
              ) : (
                <div className={s.entryList}>
                  {data.memory.entries.map((entry) => (
                    <article key={entry.index} className={s.entryCard}>
                      {editingIndex === entry.index ? (
                        <div className={s.formCard}>
                          <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} rows={3} autoFocus />
                          <div className={s.formActions}>
                            <span>{editContent.length} 字符</span>
                            <Button type="button" variant="outline" size="sm" onClick={() => setEditingIndex(null)}>取消</Button>
                            <Button type="button" variant="solid" tone="accent" size="sm" onClick={handleSaveEdit} disabled={updateEntry.isPending}>保存</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p>{entry.content}</p>
                          <div className={s.entryActions}>
                            <Button type="button" variant="plain" size="inherit" onClick={() => { setEditingIndex(entry.index); setEditContent(entry.content); }}>编辑</Button>
                            {confirmDelete === entry.index ? (
                              <span className={s.confirmDelete}>
                                确认删除？
                                <Button type="button" variant="plain" size="inherit" onClick={() => removeEntry.mutate(entry.index, { onSuccess: () => setConfirmDelete(null) })}>是</Button>
                                <Button type="button" variant="plain" size="inherit" onClick={() => setConfirmDelete(null)}>否</Button>
                              </span>
                            ) : (
                              <Button type="button" variant="plain" size="inherit" onClick={() => setConfirmDelete(entry.index)}><Trash2 size={13} /></Button>
                            )}
                          </div>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === "profile" && (
            <section className={s.panel}>
              <div className={s.panelHead}>
                <div>
                  <strong>用户画像</strong>
                  <span>告诉 Hermes 关于你的信息、偏好、环境和沟通风格。</span>
                </div>
                {savedFlash && <span className={s.saved}>已保存</span>}
              </div>
              <div className={s.profileEditor}>
                <textarea
                  className={s.profileTextarea}
                  value={userContent}
                  onChange={(event) => { setUserContent(event.target.value); setUserDirty(true); }}
                  placeholder="姓名小李，使用 macOS 和 zsh，偏好简洁的中文回答。"
                  rows={9}
                />
                <div className={`${s.formActions} ${s.profileFooter}`}>
                  <span>{userContent.length} / {data.user.charLimit} 字符</span>
                  <Button type="button" variant="solid" tone="accent" size="sm" onClick={handleSaveUser} disabled={!userDirty || saveUser.isPending}>保存画像</Button>
                </div>
              </div>
            </section>
          )}
        </div>
      )}
    </SectionShell>
  );
}
