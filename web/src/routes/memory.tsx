import { useEffect, useMemo, useState } from "react";
import { Brain, Check, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  useAddMemoryEntry,
  useMemory,
  useMemoryProviders,
  useRemoveMemoryEntry,
  useSaveUserProfile,
  useSetMemoryProvider,
  useUpdateMemoryEntry,
  type MemoryProviderOption,
} from "@/hooks/use-memory";
import { memoryPageStats, formatMemoryPageStat } from "@/lib/memory-page-stats";
import { SectionShell } from "./section-shell";
import s from "./memory.module.css";

const PROVIDER_URLS: Record<string, string> = {
  honcho: "https://app.honcho.dev",
  hindsight: "https://ui.hindsight.vectorize.io",
  mem0: "https://app.mem0.ai",
  retaindb: "https://retaindb.com",
  supermemory: "https://supermemory.ai",
  byterover: "https://app.byterover.dev",
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  builtin: "内置文件记忆，直接写入当前档案的 memories/MEMORY.md 与 USER.md。",
  honcho: "基于 AI 的跨会话用户画像建模，支持语义搜索与长期偏好记录。",
  hindsight: "长期记忆，具有知识图谱和多策略检索能力。",
  mem0: "服务端 LLM 事实提取，支持语义搜索和自动去重。",
  retaindb: "云端记忆 API，支持混合搜索和多类型记忆。",
  supermemory: "语义长期记忆，支持档案回忆和实体提取。",
  holographic: "本地 SQLite 事实存储，支持全文搜索和信任评分，无需 API Key。",
  openviking: "会话管理的记忆，支持分层检索和知识浏览。",
  byterover: "持久化知识树，通过 brv CLI 进行分层检索。",
};

const PROVIDER_ENV_HINTS: Record<string, string[]> = {
  honcho: ["HONCHO_API_KEY", "HONCHO_BASE_URL"],
  hindsight: ["HINDSIGHT_API_KEY", "HINDSIGHT_API_URL", "HINDSIGHT_BANK_ID"],
  mem0: ["MEM0_API_KEY"],
  retaindb: ["RETAINDB_API_KEY"],
  supermemory: ["SUPERMEMORY_API_KEY"],
  byterover: ["BRV_API_KEY"],
};

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "未创建";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "刚刚更新";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function providerDescription(provider: MemoryProviderOption): string {
  const raw = provider.description || "";
  const key = raw.startsWith("memory.providers.") ? raw.split(".").pop() || provider.name : provider.name;
  return PROVIDER_DESCRIPTIONS[key] ?? (raw || "外置记忆系统。");
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
  const [tab, setTab] = useState<"entries" | "profile" | "providers">("entries");
  const providersQuery = useMemoryProviders({ enabled: tab === "providers" });
  const setProvider = useSetMemoryProvider();
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

  const providers = useMemo(() => {
    const builtin: MemoryProviderOption = { name: "builtin", description: PROVIDER_DESCRIPTIONS.builtin };
    const remote = providersQuery.data?.options ?? [];
    const seen = new Set([builtin.name]);
    return [builtin, ...remote.filter((item) => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    })];
  }, [providersQuery.data?.options]);

  const activeProvider = providersQuery.data?.active || "builtin";
  const activeProviderLabel = providersQuery.data ? activeProvider : "配置";
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
    <button type="button" className={s.iconButton} onClick={() => void memoryQuery.refetch()} disabled={memoryQuery.isFetching}>
      <RefreshCw size={14} />
      {memoryQuery.isFetching ? "刷新中" : "刷新"}
    </button>
  );

  return (
    <SectionShell title="记忆" sub="MEMORY.md / USER.md" right={right}>
      {memoryQuery.isError && !data ? (
        <div className={s.memoryPage}>
          <div className={s.errorState}>无法读取记忆：{errorMessage(memoryQuery.error)}</div>
          <button type="button" className={s.secondaryButton} onClick={() => void memoryQuery.refetch()}>重试</button>
        </div>
      ) : isLoading || !data ? (
        <div className={s.emptyState}>加载记忆中…</div>
      ) : (
        <div className={s.memoryPage}>
          <p className={s.desc}>
            这里管理当前档案的长期记忆。记忆用于保存跨会话事实，用户画像用于描述你的偏好、角色和沟通方式。
          </p>

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
              记忆 <span>{timeAgo(data.memory.lastModified)}</span>
            </button>
            <button type="button" data-active={tab === "profile" ? "true" : undefined} onClick={() => setTab("profile")}>
              用户画像 <span>{timeAgo(data.user.lastModified)}</span>
            </button>
            <button type="button" data-active={tab === "providers" ? "true" : undefined} onClick={() => setTab("providers")}>
              外置记忆系统 <span>{activeProviderLabel}</span>
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
                <button type="button" className={s.primaryButton} onClick={() => setShowAdd((v) => !v)}>
                  <Plus size={14} /> 添加记忆
                </button>
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
                    <button type="button" className={s.secondaryButton} onClick={() => { setShowAdd(false); setNewEntry(""); }}>取消</button>
                    <button type="button" className={s.primaryButton} onClick={handleAdd} disabled={!newEntry.trim() || addEntry.isPending}>保存</button>
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
                            <button type="button" className={s.secondaryButton} onClick={() => setEditingIndex(null)}>取消</button>
                            <button type="button" className={s.primaryButton} onClick={handleSaveEdit} disabled={updateEntry.isPending}>保存</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p>{entry.content}</p>
                          <div className={s.entryActions}>
                            <button type="button" onClick={() => { setEditingIndex(entry.index); setEditContent(entry.content); }}>编辑</button>
                            {confirmDelete === entry.index ? (
                              <span className={s.confirmDelete}>
                                确认删除？
                                <button type="button" onClick={() => removeEntry.mutate(entry.index, { onSuccess: () => setConfirmDelete(null) })}>是</button>
                                <button type="button" onClick={() => setConfirmDelete(null)}>否</button>
                              </span>
                            ) : (
                              <button type="button" onClick={() => setConfirmDelete(entry.index)}><Trash2 size={13} /></button>
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
                  placeholder="例如：姓名小林。使用 macOS 和 zsh。偏好简洁但完整的中文回答。"
                  rows={9}
                />
                <div className={`${s.formActions} ${s.profileFooter}`}>
                  <span>{userContent.length} / {data.user.charLimit} 字符</span>
                  <button type="button" className={s.primaryButton} onClick={handleSaveUser} disabled={!userDirty || saveUser.isPending}>保存画像</button>
                </div>
              </div>
            </section>
          )}

          {tab === "providers" && (
            <section className={s.panel}>
              <div className={s.panelHead}>
                <div>
                  <strong>外置记忆系统</strong>
                  <span>当前 {activeProvider}</span>
                </div>
              </div>
              <p className={s.providerHint}>
                内置文件记忆始终可用；外置记忆系统用于增强长期召回。部分系统需要先在 <code>.env</code> 中配置 API Key，或运行 <code>hermes memory setup</code> 完成初始化。
              </p>
              {providersQuery.isError && <div className={s.errorState}>无法读取外置记忆系统列表，仍可继续使用内置文件记忆。</div>}
              <div className={s.providerGrid}>
                {providers.map((provider) => {
                  const active = activeProvider === provider.name || (activeProvider === "" && provider.name === "builtin");
                  const externalUrl = PROVIDER_URLS[provider.name];
                  const envHints = PROVIDER_ENV_HINTS[provider.name] ?? [];
                  return (
                    <article key={provider.name} className={s.providerCard} data-active={active ? "true" : undefined}>
                      <div className={s.providerHead}>
                        <strong>{provider.name === "builtin" ? "内置记忆" : provider.name}</strong>
                        {active && <span><Check size={11} /> 当前</span>}
                      </div>
                      <p>{provider.name === "builtin" ? PROVIDER_DESCRIPTIONS.builtin : providerDescription(provider)}</p>
                      {envHints.length > 0 && <div className={s.envHints}>{envHints.map((key) => <code key={key}>{key}</code>)}</div>}
                      <div className={s.providerActions}>
                        {externalUrl && (
                          <a href={externalUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> 官网</a>
                        )}
                        <button
                          type="button"
                          className={active ? s.secondaryButton : s.primaryButton}
                          disabled={active || setProvider.isPending}
                          onClick={() => setProvider.mutate(provider.name === "builtin" ? "" : provider.name)}
                        >
                          {active ? "已启用" : "设为当前"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </SectionShell>
  );
}
