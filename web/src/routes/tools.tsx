import { useMemo, useState } from "react";
import { Wrench, Boxes, Search, CheckSquare, Puzzle } from "lucide-react";
import { PageTabs, type PageTabItem } from "@hermes/shared-ui";
import {
  CONFIGURABLE_TOOLSETS,
  getAllToolsetKeys,
  getCategory,
  getCategoryForTool,
  listCategories,
  registry,
  resolveMultipleToolsets,
  type ToolCatalogEntry,
  type ToolCategory,
  type ToolCategoryId,
} from "@hermes/agent-tools";
import { TopBar } from "@/components/top-bar/top-bar";
import { estimateToolSetTokensSync } from "@hermes/agent-tools";
import s from "./tools.module.css";

type Tab = "toolsets" | "tools" | "custom";

const TABS: PageTabItem<Tab>[] = [
  { value: "toolsets", label: "工具集", icon: <Boxes size={12} /> },
  { value: "tools", label: "工具", icon: <CheckSquare size={12} /> },
  { value: "custom", label: "自定义", icon: <Puzzle size={12} /> },
];

export function ToolsRoute() {
  const [tab, setTab] = useState<Tab>("toolsets");
  const [query, setQuery] = useState("");
  const [enabledToolsets, setEnabledToolsets] = useState<string[]>(["hermes_cli"]);

  const toolsetKeys = useMemo(() => getAllToolsetKeys(), []);

  const catalog = useMemo<ToolCatalogEntry[]>(() => {
    const resolved = resolveMultipleToolsets(enabledToolsets);
    return registry.names().map((name) => {
      const entry = registry.get(name)!;
      return {
        name,
        toolset: entry.toolset,
        description: entry.description ?? "",
        requiresEnv: entry.requiresEnv ?? [],
        gate: entry.checkFn ? "capability" : "none",
        enabled: resolved.has(name),
      };
    });
  }, [enabledToolsets]);

  const filteredCatalog = useMemo(() => {
    const q = query.toLowerCase();
    return catalog.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.toolset.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const groupedCatalog = useMemo(() => {
    const byCategory = new Map<ToolCategoryId, ToolCatalogEntry[]>();
    const unknown: ToolCatalogEntry[] = [];
    for (const entry of filteredCatalog) {
      const categoryId = getCategoryForTool(entry.name, entry.toolset);
      if (categoryId) {
        const list = byCategory.get(categoryId) ?? [];
        list.push(entry);
        byCategory.set(categoryId, list);
      } else {
        unknown.push(entry);
      }
    }

    const groups: { category: ToolCategory; tools: ToolCatalogEntry[] }[] = [];
    for (const cat of listCategories()) {
      const tools = byCategory.get(cat.id);
      if (tools && tools.length > 0) {
        groups.push({ category: cat, tools });
      }
    }
    if (unknown.length > 0) {
      groups.push({
        category: {
          id: "integrations" as ToolCategoryId, // fallback; integrations is the broadest bucket
          labelZh: "其他",
          labelEn: "Other",
          icon: "📦",
          description: "Tools without a mapped category.",
          toolsets: [],
        },
        tools: unknown,
      });
    }
    return groups;
  }, [filteredCatalog]);

  const tokenEstimate = useMemo(() => {
    const defs = registry
      .getDefinitionsSync(new Set(filteredCatalog.filter((t) => t.enabled).map((t) => t.name)));
    return estimateToolSetTokensSync(defs);
  }, [filteredCatalog]);

  const toggleToolset = (key: string) => {
    setEnabledToolsets((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  return (
    <div className={s.page}>
      <TopBar title={<><Wrench size={16} /> 工具</>} />
      <div className={s.content}>
        <PageTabs aria-label="工具页面" items={TABS} value={tab} onValueChange={setTab} />

        {tab === "toolsets" && (
          <>
            <div className={s.toolbar}>
              <span className={s.status}>已启用 {enabledToolsets.length} 个工具集 · 约 {tokenEstimate} tokens</span>
            </div>
            <div className={s.grid}>
              {toolsetKeys.map((key) => {
                const meta = CONFIGURABLE_TOOLSETS[key];
                const enabled = enabledToolsets.includes(key);
                return (
                  <button
                    key={key}
                    className={s.card}
                    onClick={() => toggleToolset(key)}
                    type="button"
                    aria-pressed={enabled}
                  >
                    <div className={s.cardHeader}>
                      <span>{meta?.emoji ?? "🔧"}</span>
                      <span>{meta?.label ?? key}</span>
                      {enabled && <CheckSquare size={12} />}
                    </div>
                    <div className={s.cardDesc}>{meta?.label ? meta.label : key}</div>
                    <div className={s.cardMeta}>{key}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {tab === "tools" && (
          <>
            <div className={s.toolbar}>
              <div className={s.search}>
                <Search size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索工具名、描述或工具集"
                />
              </div>
              <span className={s.status}>{filteredCatalog.length} tools · {tokenEstimate} tokens</span>
            </div>
            <div className={s.grid}>
                {groupedCatalog.map(({ category, tools }) => (
                  <section key={category.id} className={s.categorySection}>
                    <h3 className={s.categoryTitle}>
                      <span>{category.icon}</span>
                      <span>{category.labelZh}</span>
                      <span className={s.categoryTitleEn}>{category.labelEn}</span>
                      <span className={s.categoryCount}>{tools.length}</span>
                    </h3>
                    <div className={s.grid}>
                      {tools.map((t) => (
                        <div key={t.name} className={s.card} data-enabled={t.enabled}>
                          <div className={s.cardHeader}>
                            <span>{t.enabled ? "✅" : "⬜"}</span>
                            <span>{t.name}</span>
                            <span className={s.cardMeta}>{t.gate !== "none" ? `[${t.gate}]` : ""}</span>
                          </div>
                          <div className={s.cardDesc}>{t.description}</div>
                          <div className={s.cardMeta}>
                            {t.toolset}
                            {t.requiresEnv.length > 0 && ` · env: ${t.requiresEnv.join(", ")}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
                {filteredCatalog.length === 0 && <div className={s.empty}>无匹配工具</div>}
            </div>
          </>
        )}

        {tab === "custom" && (
          <div className={s.card}>
            <div className={s.cardHeader}>自定义工具集</div>
            <div className={s.cardDesc}>
              自定义工具集编辑器即将上线。现在可通过 /toolsets create 命令在对话中创建。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
