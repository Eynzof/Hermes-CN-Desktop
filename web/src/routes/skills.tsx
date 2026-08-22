import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BarChart3,
  Copy,
  Folder,
  Info,
  Languages,
  Lock,
  Package,
  Plus,
  RefreshCw,
  Store,
  User,
} from "lucide-react";
import type { SkillInfo } from "@hermes/protocol";
import { LoadingState, PageTabs, type PageTabItem } from "@hermes/shared-ui";
import { useSkillMarkdown, useSkills, useToggleSkill } from "@/hooks/use-skills";
import {
  useActiveProfileName,
  useManagementProfile,
  useProfiles,
  useSetManagementProfile,
} from "@/hooks/use-profiles";
import { ProfileScopeBanner } from "@/components/profiles";
import { Pill, Dot } from "@/components/ui/pill";
import {
  categoryTranslations,
  skillTranslations,
  translateCategory,
  translateSkill,
} from "@/lib/skill-translations";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import { TopBar, TopBarActionButton } from "@/components/top-bar/top-bar";
import { CopyButton } from "@/components/ui/copy-button";
import { SkillUsageStats } from "@/components/skills/skill-usage-stats";
import { SkillsHubPanel } from "@/components/settings/skills-hub-panel";
import {
  isUserSkill,
  resolveSkillOrigin,
  skillDirectory,
  type SkillOrigin,
} from "@/lib/skill-origin";
import s from "./skills.module.css";

type Tab = "builtin" | "market" | "stats" | "user";
type Filter = "all" | "enabled" | "disabled";
type Lang = "zh" | "en";

function sourceLabel(origin: SkillOrigin): string {
  if (origin === "builtin") return "Hermes 内置";
  if (origin === "external") return "外部目录";
  return "用户自建";
}

function markdownWithoutFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return content;
  return normalized.slice(match[0].length).replace(/^\s+/, "");
}

export function SkillsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  // 管理范围：/skills?profile=X 深链或档案页「管理技能」会设它。scope ≠ 活跃档案时，
  // 技能列表/启停就地作用于该档案（不切换 dashboard），并显示提示横幅。
  const active = useActiveProfileName();
  const mgmt = useManagementProfile();
  const setMgmt = useSetManagementProfile();
  const scope = mgmt && mgmt !== active ? mgmt : null;
  const profilesQuery = useProfiles();
  const profileNames = (profilesQuery.data ?? []).map((p) => p.name);
  const urlProfile = searchParams.get("profile");
  useEffect(() => {
    if (urlProfile) setMgmt(urlProfile);
  }, [urlProfile, setMgmt]);

  // Sync management scope TO the URL whenever it changes, so the scope
  // survives page refresh (Bug #4 fix — URL-Driven Scope).
  // Handles both onSelect changes and external clearing (active-profile switch).
  useEffect(() => {
    setSearchParams((prev) => {
      const current = mgmt && mgmt !== active ? mgmt : null;
      const inUrl = prev.get("profile");
      if (current && current !== inUrl) {
        prev.set("profile", current);
      } else if (!current && inUrl) {
        prev.delete("profile");
      } else {
        return prev; // already in sync — skip update
      }
      return prev;
    }, { replace: true });
  }, [mgmt, active, setSearchParams]);

  const { data: skills, isLoading, isFetching, isError, error, refetch } = useSkills(scope);
  const toggleSkill = useToggleSkill(scope);
  const [tab, setTab] = useState<Tab>("builtin");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("zh");
  const selectedFromQuery = searchParams.get("skill");

  const { builtin, user } = useMemo(() => {
    const all = skills ?? [];
    return {
      builtin: all.filter((sk) => !isUserSkill(sk)),
      user: all.filter((sk) => isUserSkill(sk)),
    };
  }, [skills]);

  const currentList = tab === "builtin" ? builtin : tab === "user" ? user : [];
  const enabledCount = (skills ?? []).filter((sk) => sk.enabled).length;

  useEffect(() => {
    if (!selectedFromQuery || !skills?.length) return;
    const target = skills.find((sk) => sk.name === selectedFromQuery);
    if (!target) return;
    setTab(isUserSkill(target) ? "user" : "builtin");
    setFilter("all");
    setSearch("");
    setSelectedName(target.name);
  }, [selectedFromQuery, skills]);

  // 过滤 + 搜索
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return currentList.filter((sk) => {
      if (filter === "enabled" && !sk.enabled) return false;
      if (filter === "disabled" && sk.enabled) return false;
      if (!q) return true;
      const tr = skillTranslations[sk.name];
      const haystack = [
        sk.name,
        sk.description,
        tr?.displayName ?? "",
        tr?.description ?? "",
        translateCategory(sk.category),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [currentList, filter, search]);

  // 按类目分组
  const grouped = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    for (const sk of filtered) {
      const cat = sk.category ?? "other";
      const arr = map.get(cat) ?? [];
      arr.push(sk);
      map.set(cat, arr);
    }
    // 确保 categoryTranslations 里的顺序优先（已知类目按表序，未知类目按字母序）
    const knownOrder = Object.keys(categoryTranslations);
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = knownOrder.indexOf(a);
      const bi = knownOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [filtered]);

  // 选中态：默认选第一个
  const selected =
    filtered.find((sk) => sk.name === selectedName) ?? filtered[0] ?? null;

  const tabHint = (
    <span className={s.tabHint}>
      <Info size={12} />
      {tab === "builtin"
        ? "内置 Skill 由 Hermes 团队维护，仅可启用 / 禁用"
        : tab === "market"
          ? "精选 Skill 市场与目录，点击卡片会在外部浏览器打开"
          : tab === "stats"
            ? "按当前管理档案统计已完成的 Skill 加载调用"
            : "自建 Skill 保存在"}
      {tab === "user" && <code>~/.hermes/skills/</code>}
    </span>
  );

  return (
    <main className={s.page}>
      <TopBar
        title="技能"
        sub={skills
          ? `${builtin.length} 个内置 · ${user.length} 个自建 · ${enabledCount} 已启用`
          : isLoading
            ? "加载中…"
            : "—"}
        right={
          <TopBarActionButton
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            loading={isFetching}
            leadingIcon={<RefreshCw size={12} />}
          >
            同步内置
          </TopBarActionButton>
        }
      />

      <PageTabs
        aria-label="技能页面"
        items={[
          { value: "builtin", label: "内置 Skills", icon: <Package />, count: builtin.length },
          { value: "market", label: "Skill 市场", icon: <Store /> },
          { value: "stats", label: "统计", icon: <BarChart3 /> },
          { value: "user", label: "我的 Skills", icon: <User />, count: user.length },
        ] satisfies readonly PageTabItem<Tab>[]}
        value={tab}
        onValueChange={(nextTab) => {
          setTab(nextTab);
          setSelectedName(null);
        }}
        end={tabHint}
      />

      {scope && (
        <div className={s.scopeRail}>
          <ProfileScopeBanner
            scope={scope}
            profileNames={profileNames}
            onSelect={(name) => setMgmt(name && name !== active ? name : null)}
          />
        </div>
      )}

      {/* 主体 */}
      {tab === "market" ? (
        <SkillsHubPanel onInstalled={() => void refetch()} onUninstalled={() => void refetch()} />
      ) : tab === "stats" ? (
        <SkillUsageStats profileOverride={scope} />
      ) : isLoading ? (
        <LoadingState variant="page" label="正在加载技能…" />
      ) : isError ? (
        <div className={s.statePane}>
          技能加载失败：{error instanceof Error ? error.message : "unknown error"}
        </div>
      ) : tab === "user" && user.length === 0 ? (
        <UserEmptyState />
      ) : (
        <div className={s.split}>
          <aside className={s.listSide}>
            <div className={s.listTools}>
              <div className={s.searchInput}>
                <span style={{ opacity: 0.6 }}>⌕</span>
                <input
                  placeholder={
                    tab === "builtin" ? "搜索 Skill 名 / 描述…" : "搜索我的 Skill…"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className={s.seg}>
                <button
                  type="button"
                  data-active={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  全部 {currentList.length}
                </button>
                <button
                  type="button"
                  data-active={filter === "enabled"}
                  onClick={() => setFilter("enabled")}
                >
                  已启用 {currentList.filter((sk) => sk.enabled).length}
                </button>
                <button
                  type="button"
                  data-active={filter === "disabled"}
                  onClick={() => setFilter("disabled")}
                >
                  已禁用 {currentList.filter((sk) => !sk.enabled).length}
                </button>
              </div>
            </div>

            <div className={s.skillsList}>
              {filtered.length === 0 ? (
                <div className={s.statePane}>没有匹配的技能。</div>
              ) : (
                grouped.map(([category, items]) => (
                  <div key={category}>
                    <div className={s.groupHead}>
                      <span className={s.groupHeadCn}>{translateCategory(category)}</span>
                      <span className={s.groupHeadEn}>{category}</span>
                      <span className={s.groupHeadNum}>{items.length}</span>
                    </div>
                    {items.map((sk) => (
                      <SkillRow
                        key={sk.name}
                        skill={sk}
                        active={selected?.name === sk.name}
                        onSelect={() => setSelectedName(sk.name)}
                        onToggle={() =>
                          toggleSkill.mutate({ name: sk.name, enabled: !sk.enabled })
                        }
                        showBuiltinTag={tab === "builtin" && selected?.name === sk.name}
                      />
                    ))}
                  </div>
                ))
              )}

              {tab === "builtin" && filtered.length > 0 && (
                <div className={s.listFooterHint}>
                  共 {filtered.length} 个内置 Skill。未翻译的会显示英文原名。
                </div>
              )}
            </div>
          </aside>

          {selected ? (
            <SkillDetail
              skill={selected}
              tab={tab}
              lang={lang}
              setLang={setLang}
              profileOverride={scope}
              onToggle={() =>
                toggleSkill.mutate({ name: selected.name, enabled: !selected.enabled })
              }
            />
          ) : (
            <section className={s.detail}>
              <div className={s.detailEmpty}>从左侧选择一个技能查看详情</div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

/* ── Skill 行 ─────────────────────────────────────────────── */

interface SkillRowProps {
  skill: SkillInfo;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  showBuiltinTag: boolean;
}

function SkillRow({ skill, active, onSelect, onToggle, showBuiltinTag }: SkillRowProps) {
  const tr = translateSkill(skill.name, skill.description);
  const isTranslated = skill.name in skillTranslations;

  return (
    <div
      role="button"
      tabIndex={0}
      className={s.skillRow}
      data-active={active}
      data-disabled={!skill.enabled}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className={s.skillRowHead}>
        <Dot tone={skill.enabled ? "ok" : "neutral"} />
        <span className={s.skillRowName}>{tr.displayName}</span>
        {showBuiltinTag && <span className={`${s.rowTag} ${s.rowTagBuiltin}`}>内置</span>}
        <span className={s.skillToggleSlot} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={s.toggle}
            data-on={skill.enabled}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={skill.enabled ? "禁用" : "启用"}
          />
        </span>
      </div>
      {isTranslated && <div className={s.skillRowNameEn}>{skill.name}</div>}
      <div className={s.skillRowDesc}>{tr.description}</div>
    </div>
  );
}

/* ── 详情面板（内置 / 自建 共用骨架，按 tab 分支渲染） ─────── */

interface SkillDetailProps {
  skill: SkillInfo;
  tab: Tab;
  lang: Lang;
  setLang: (l: Lang) => void;
  profileOverride?: string | null;
  onToggle: () => void;
}

function SkillDetail({
  skill,
  tab,
  lang,
  setLang,
  profileOverride,
  onToggle,
}: SkillDetailProps) {
  const tr = translateSkill(skill.name, skill.description);
  const isTranslated = skill.name in skillTranslations;
  const cnCategory = translateCategory(skill.category);
  const origin = resolveSkillOrigin(skill);
  const markdownQuery = useSkillMarkdown(skill.name, profileOverride);
  const markdown = markdownQuery.data;
  const skillFile = markdown?.path || skill.skill_file || "";
  const resolvedSourcePath =
    skill.source_path || (markdown?.path ? skillDirectory(markdown.path) : "");
  const sourcePath =
    resolvedSourcePath || (markdownQuery.isError ? "后端未返回来源目录" : "正在读取来源目录…");

  return (
    <section className={s.detail}>
      <div className={s.detailHead}>
        <div className={s.detailHeadRow1}>
          <h1 className={s.detailHeadTitle}>{tr.displayName}</h1>
        </div>
        <div className={s.detailHeadRow2}>
          <span className={`${s.rowTag} ${tab === "builtin" ? s.rowTagBuiltin : s.rowTagUser}`}>
            {tab === "builtin" ? "内置" : "自建"}
          </span>
          <div className={s.detailPills}>
            <Pill tone={skill.enabled ? "ok" : "neutral"}>
              <Dot tone={skill.enabled ? "ok" : "neutral"} />
              {skill.enabled ? "已启用" : "已禁用"}
            </Pill>
            <Pill>类目 · {cnCategory}</Pill>
            {!isTranslated && tab === "builtin" && (
              <Pill tone="warn">未翻译 · 显示英文原文</Pill>
            )}
          </div>
          <div className={s.detailHeadActions}>
            <CopyButton
              text={skill.name}
              className={s.btn}
              title="复制原文 ID"
            >
              <Copy size={12} />
              复制 ID
            </CopyButton>
            <button
              type="button"
              className={s.btn}
              onClick={onToggle}
              title={skill.enabled ? "禁用" : "启用"}
            >
              {skill.enabled ? "禁用" : "启用"}
            </button>
          </div>
        </div>
        {isTranslated && (
          <div className={s.nameEnBig}>
            <span>{skill.name}</span>
            <CopyButton
              text={skill.name}
              className={s.nameEnCopy}
            >
              复制
            </CopyButton>
          </div>
        )}


        {tab === "builtin" && (
          <div className={s.readonlyNotice}>
            <Lock size={16} className={s.readonlyLock} />
            <div>
              <strong>这是 Hermes 内置 Skill。</strong>
              只能启用 / 禁用，不能修改。下次执行 <code>同步内置</code> 时会被覆盖。
              如需自定义，请在「我的 Skills」里基于此 Skill 复制一份。
            </div>
          </div>
        )}

        <div className={s.metaRow}>
          <span className={s.metaItem}>
            <span className={s.metaK}>原文 ID</span>
            <span className={s.metaV}>{skill.name}</span>
          </span>
          <span className={s.metaItem}>
            <span className={s.metaK}>类目</span>
            <span className={s.metaV}>{skill.category ?? "other"}</span>
          </span>
          <span className={s.metaItem}>
            <span className={s.metaK}>来源</span>
            <span className={s.metaV}>{sourceLabel(origin)}</span>
          </span>
        </div>
      </div>

      <div className={s.detailBody}>
        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>说明</h2>
            <div className={s.secHeadRight}>
              {isTranslated && (
                <>
                  <span>由 Hermes 中文社区维护翻译</span>
                  <div className={s.langSeg}>
                    <button
                      type="button"
                      data-active={lang === "zh"}
                      onClick={() => setLang("zh")}
                    >
                      中
                    </button>
                    <button
                      type="button"
                      data-active={lang === "en"}
                      onClick={() => setLang("en")}
                    >
                      EN 原文
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className={s.descriptionCard}>
            {lang === "zh" && isTranslated ? (
              <p>{tr.description}</p>
            ) : (
              <p className={s.descriptionCardOriginal}>{skill.description}</p>
            )}
            {isTranslated ? (
              <div className={s.descriptionCardFooter}>
                <Languages size={12} />
                中文版基于 SKILL.md description 字段翻译。完整 SKILL.md 内容请到来源目录查看。
              </div>
            ) : null}
          </div>
        </section>

        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>SKILL.md</h2>
            <div className={s.secHeadRight}>
              {markdown?.content ? (
                <CopyButton text={markdown.content} className={s.btn}>
                  <Copy size={12} />
                  复制 Markdown
                </CopyButton>
              ) : null}
            </div>
          </div>
          <div className={s.markdownCard} aria-busy={markdownQuery.isFetching}>
            {markdownQuery.isLoading ? (
              <LoadingState variant="block" label="正在读取 SKILL.md…" />
            ) : markdownQuery.isError ? (
              <div className={s.markdownState} data-tone="error">
                读取失败：{markdownQuery.error instanceof Error ? markdownQuery.error.message : "unknown error"}
              </div>
            ) : markdown?.content ? (
              <div className={s.skillMarkdown}>
                <MarkdownText text={markdownWithoutFrontmatter(markdown.content)} />
              </div>
            ) : (
              <div className={s.markdownState}>没有可展示的 SKILL.md 内容。</div>
            )}
          </div>
        </section>

        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>来源目录</h2>
          </div>
          <div className={`${s.descriptionCard} ${s.sourceCard}`}>
            <div className={s.sourceRow}>
              <Folder size={16} className={s.sourceIcon} />
              <div className={s.sourceText}>
                <span className={s.sourceLabel}>实际安装目录</span>
                <code>{sourcePath}</code>
              </div>
              {resolvedSourcePath && (
                <CopyButton text={resolvedSourcePath} className={s.btn}>
                  <Copy size={12} />
                  复制
                </CopyButton>
              )}
            </div>
            {skillFile && (
              <div className={s.sourceRow}>
                <Folder size={16} className={s.sourceIcon} />
                <div className={s.sourceText}>
                  <span className={s.sourceLabel}>SKILL.md</span>
                  <code>{skillFile}</code>
                </div>
                <CopyButton text={skillFile} className={s.btn}>
                  <Copy size={12} />
                  复制
                </CopyButton>
              </div>
            )}
            <p className={s.sourceHint}>
              这里展示的是后端实际扫描到的 Skill 副本。内置 Skill 会从自带 runtime 包同步到当前 Hermes home；
              自建或外部目录 Skill 则显示它们自己的安装位置。
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}

/* ── 「我的 Skills」空状态 ─────────────────────────────────── */

function UserEmptyState() {
  return (
    <div className={s.emptyState}>
      <div className={s.emptyStateIcon}>
        <User size={28} />
      </div>
      <h2 className={s.emptyStateTitle}>还没有自建 Skill</h2>
      <p className={s.emptyStateBody}>
        在 Hermes Agent 中沉淀你自己的工作流：写一份 <code>SKILL.md</code>，
        放到 <code>~/.hermes/skills/&lt;分类&gt;/&lt;名称&gt;/</code> 目录下，
        刷新就会出现在这里。
        <br />
        在线编辑器规划中——目前请通过文件系统手动管理。
      </p>
      <div className={s.emptyStateActions}>
        <button type="button" className={s.btn}>
          <Folder size={12} />
          打开 ~/.hermes/skills/
        </button>
        <button type="button" className={s.btnPrimary}>
          <Plus size={12} />
          基于内置 Skill 复制
        </button>
      </div>
    </div>
  );
}

