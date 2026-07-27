import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { PluginHubRow } from "@hermes/protocol";
import { Alert, Button } from "@hermes/shared-ui";
import {
  AlertTriangle,
  Boxes,
  Download,
  ExternalLink,
  GitPullRequestArrow,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  useInstallPlugin,
  usePluginsHub,
  useRemovePlugin,
  useSetPluginEnabled,
  useUpdatePlugin,
} from "@/hooks/use-plugins";
import {
  filterPlugins,
  pluginCanToggle,
  pluginEffectiveStatus,
  pluginKindLabel,
  pluginSourceLabel,
  pluginStatusLabel,
  summarizePlugins,
  type PluginFilters,
} from "@/lib/plugins";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import settings from "./settings.module.css";
import s from "./plugins.module.css";

const DEFAULT_FILTERS: PluginFilters = {
  query: "",
  source: "all",
  kind: "all",
  status: "all",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluginKey(plugin: PluginHubRow): string {
  return plugin.key || plugin.name;
}

function CapabilityList({ label, values }: { label: string; values: readonly string[] }) {
  if (!values.length) return null;
  return (
    <div className={s.capabilityRow}>
      <span>{label}</span>
      <div className={s.chips}>
        {values.map((value) => <code key={value}>{value}</code>)}
      </div>
    </div>
  );
}

interface PluginCardProps {
  plugin: PluginHubRow;
  busy: boolean;
  onToggle: (plugin: PluginHubRow, enabled: boolean) => void;
  onUpdate: (plugin: PluginHubRow) => void;
  onRemove: (plugin: PluginHubRow) => void;
}

function PluginCard({ plugin, busy, onToggle, onUpdate, onRemove }: PluginCardProps) {
  const status = pluginEffectiveStatus(plugin);
  const active = status === "enabled" || status === "auto-active";
  const canToggle = pluginCanToggle(plugin);
  const managedPath = plugin.kind === "exclusive" ? "/memory" : "/models";

  return (
    <article className={s.pluginCard} data-status={status} aria-busy={busy || undefined}>
      <div className={s.pluginHeader}>
        <div className={s.pluginIdentity}>
          <span className={s.pluginIcon}><Puzzle size={16} /></span>
          <div>
            <div className={s.pluginTitleRow}>
              <h3>{plugin.name}</h3>
              <span className={s.statusBadge} data-status={status}>{pluginStatusLabel(status)}</span>
            </div>
            <div className={s.pluginKey}>{pluginKey(plugin)}</div>
          </div>
        </div>
        <div className={s.pluginActions}>
          {canToggle ? (
            <Button
              size="sm"
              variant={active ? "outline" : "solid"}
              tone={active ? "warning" : "accent"}
              loading={busy}
              onClick={() => onToggle(plugin, !active)}
            >
              {active ? "禁用" : "启用"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <Settings2 size={13} /> Provider 管理
            </Button>
          )}
          {!canToggle ? (
            <Link className={s.inlineLink} to={managedPath}>前往设置 <ExternalLink size={12} /></Link>
          ) : null}
          {plugin.can_update_git ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onUpdate(plugin)}>
              <GitPullRequestArrow size={13} /> 更新
            </Button>
          ) : null}
          {plugin.can_remove ? (
            <Button size="sm" variant="outline" tone="danger" disabled={busy} onClick={() => onRemove(plugin)}>
              <Trash2 size={13} /> 卸载
            </Button>
          ) : null}
        </div>
      </div>

      {plugin.description ? <p className={s.description}>{plugin.description}</p> : null}

      <div className={s.metaRow}>
        <span>{pluginSourceLabel(plugin.source)}</span>
        <span>{pluginKindLabel(plugin.kind)}</span>
        {plugin.version ? <span>v{plugin.version}</span> : null}
        {plugin.author ? <span>{plugin.author}</span> : null}
        {plugin.has_dashboard_manifest ? <span title="桌面端不会执行插件前端脚本">含 Dashboard 扩展</span> : null}
      </div>

      <CapabilityList label="工具" values={plugin.provides_tools} />
      <CapabilityList label="Hooks" values={plugin.provides_hooks} />
      <CapabilityList label="环境变量" values={plugin.requires_env} />

      {plugin.missing_env.length > 0 ? (
        <div className={s.missingEnv}>
          <AlertTriangle size={13} />
          缺少 {plugin.missing_env.join("、")}
          <Link to="/env">配置环境变量</Link>
        </div>
      ) : plugin.auth_required ? (
        <div className={s.missingEnv}>
          <AlertTriangle size={13} /> 该插件仍需完成认证或环境配置
          <Link to="/env">前往配置</Link>
        </div>
      ) : null}

      {plugin.path ? <div className={s.path} title={plugin.path}>{plugin.path}</div> : null}
    </article>
  );
}

export function PluginsRoute() {
  const profile = useActiveProfileName();
  const hub = usePluginsHub();
  const install = useInstallPlugin();
  const toggle = useSetPluginEnabled();
  const update = useUpdatePlugin();
  const remove = useRemovePlugin();
  const [filters, setFilters] = useState<PluginFilters>(DEFAULT_FILTERS);
  const [identifier, setIdentifier] = useState("");
  const [force, setForce] = useState(false);
  const [enableAfterInstall, setEnableAfterInstall] = useState(true);

  const plugins = hub.data?.plugins ?? [];
  const summary = useMemo(() => summarizePlugins(plugins), [plugins]);
  const filtered = useMemo(() => filterPlugins(plugins, filters), [filters, plugins]);
  const sources = useMemo(
    () => Array.from(new Set(plugins.map((plugin) => plugin.source))).sort(),
    [plugins],
  );
  const kinds = useMemo(
    () => Array.from(new Set(plugins.map((plugin) => plugin.kind))).sort(),
    [plugins],
  );

  const activeMutation = toggle.isPending && toggle.variables
    ? pluginKey(toggle.variables.plugin)
    : update.isPending && update.variables
      ? pluginKey(update.variables)
      : remove.isPending && remove.variables
        ? pluginKey(remove.variables)
        : "";
  const mutationError = toggle.error || update.error || remove.error;
  const missingHub = hub.isError && /HTTP 404\b/.test(errorText(hub.error));

  const handleInstall = () => {
    const value = identifier.trim();
    if (!value) return;
    const confirmed = window.confirm(
      `确认安装插件「${value}」？\n\n第三方插件包含会在本机执行的代码。仅安装你信任的来源；启用状态会从后续新会话开始生效。`,
    );
    if (!confirmed) return;
    install.mutate(
      { identifier: value, force, enable: enableAfterInstall },
      { onSuccess: () => setIdentifier("") },
    );
  };

  const handleRemove = (plugin: PluginHubRow) => {
    if (!window.confirm(`确认卸载插件「${plugin.name}」？\n\n插件目录会被删除，此操作无法撤销。`)) return;
    remove.mutate(plugin);
  };

  const right = (
    <Button variant="outline" onClick={() => void hub.refetch()} disabled={hub.isFetching}>
      <RefreshCw size={14} /> {hub.isFetching ? "刷新中" : "刷新"}
    </Button>
  );

  return (
    <SectionShell title="Plugins" sub={`当前档案 · ${profile}`} right={right}>
      <SettingsHero
        ok={!hub.isError}
        icon={<Puzzle size={24} />}
        eyebrow="Hermes Agent 扩展系统"
        title="插件管理"
        description="查看当前档案可发现的插件，并管理安装、启停、更新与卸载。桌面端只读取插件元数据，不会加载插件提供的任意前端脚本。"
        badge={<span className={settings.statusBadge} data-on={!hub.isError}>{hub.isLoading ? "读取中" : `${summary.total} 个插件`}</span>}
      />

      <div className={s.noticeGrid}>
        <Alert tone="info" size="sm">
          <Boxes size={14} /> 所有操作仅作用于当前档案 <strong>{profile}</strong>。切换档案后会自动重新读取。
        </Alert>
        <Alert tone="warning" size="sm">
          <AlertTriangle size={14} /> 插件启停和安装只对后续新会话生效，不会重载正在运行会话的工具集。
        </Alert>
      </div>

      {missingHub ? (
        <section className={s.compatState}>
          <Puzzle size={24} />
          <h3>当前内核尚未提供 Plugins Hub</h3>
          <p>请更新 CN-Core / 桌面端托管内核后再使用插件管理。其他页面不会受影响。</p>
          <Link className={s.primaryLink} to="/kernel">查看内核版本</Link>
        </section>
      ) : hub.isError ? (
        <Alert tone="danger" size="sm">无法读取插件清单：{errorText(hub.error)}</Alert>
      ) : (
        <>
          <section className={s.statsGrid} aria-label="插件状态汇总">
            {[
              ["全部", summary.total],
              ["生效中", summary.active],
              ["未启用", summary.inactive],
              ["已禁用", summary.disabled],
              ["Provider 管理", summary.providerManaged],
            ].map(([label, value]) => (
              <div className={s.statCard} key={label}>
                <strong>{value}</strong><span>{label}</span>
              </div>
            ))}
          </section>

          <section className={s.providerPanel}>
            <div>
              <span className={s.panelEyebrow}>Provider 状态 · 只读</span>
              <h3>能力 Provider 继续在专用页面管理</h3>
              <p>
                记忆：{hub.data?.providers.memory_provider || "内置记忆"}　·　
                上下文引擎：{hub.data?.providers.context_engine || "默认"}
              </p>
            </div>
            <div className={s.providerLinks}>
              <Link to="/memory">记忆 Provider <ExternalLink size={12} /></Link>
              <Link to="/models">模型 Provider <ExternalLink size={12} /></Link>
            </div>
          </section>

          <section className={s.installPanel}>
            <div className={s.installTitle}>
              <PackagePlus size={17} />
              <div><h3>从 Git 安装</h3><p>支持 GitHub owner/repo、HTTPS 或 SSH Git 地址。</p></div>
            </div>
            <div className={s.installForm}>
              <input
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="owner/repo 或 https://github.com/owner/repo.git"
                aria-label="插件 Git 来源"
              />
              <Button variant="solid" tone="accent" loading={install.isPending} disabled={!identifier.trim()} onClick={handleInstall}>
                <Download size={13} /> 安装
              </Button>
            </div>
            <div className={s.installOptions}>
              <label><input type="checkbox" checked={enableAfterInstall} onChange={(event) => setEnableAfterInstall(event.target.checked)} /> 安装后启用</label>
              <label><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} /> 覆盖同名目录</label>
            </div>
            {install.error ? <Alert tone="danger" size="sm">安装失败：{errorText(install.error)}</Alert> : null}
            {install.data ? (
              <Alert tone={install.data.missing_env.length ? "warning" : "success"} size="sm">
                已安装 {install.data.plugin_name || "插件"}。
                {install.data.missing_env.length ? (
                  <> 缺少 {install.data.missing_env.join("、")}，<Link to="/env">前往配置</Link>。</>
                ) : null}
                {install.data.warnings.length ? ` ${install.data.warnings.join(" ")}` : ""}
              </Alert>
            ) : null}
          </section>

          <section className={s.inventoryPanel}>
            <div className={s.filterBar}>
              <label className={s.searchBox}>
                <Search size={14} />
                <input
                  value={filters.query}
                  onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                  placeholder="搜索名称、描述、工具、Hook 或环境变量"
                />
              </label>
              <select value={filters.source} onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))} aria-label="来源筛选">
                <option value="all">全部来源</option>
                {sources.map((source) => <option key={source} value={source}>{pluginSourceLabel(source)}</option>)}
              </select>
              <select value={filters.kind} onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value }))} aria-label="类型筛选">
                <option value="all">全部类型</option>
                {kinds.map((kind) => <option key={kind} value={kind}>{pluginKindLabel(kind)}</option>)}
              </select>
              <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} aria-label="状态筛选">
                <option value="all">全部状态</option>
                <option value="enabled">已启用</option>
                <option value="auto-active">自动生效</option>
                <option value="inactive">未启用</option>
                <option value="disabled">已禁用</option>
                <option value="provider-managed">Provider 管理</option>
              </select>
            </div>

            {mutationError ? <Alert tone="danger" size="sm">操作失败：{errorText(mutationError)}</Alert> : null}
            {hub.isLoading ? <div className={s.emptyState}>正在读取插件清单…</div> : null}
            {!hub.isLoading && filtered.length === 0 ? <div className={s.emptyState}>没有符合当前筛选条件的插件。</div> : null}
            <div className={s.pluginList}>
              {filtered.map((plugin) => (
                <PluginCard
                  key={pluginKey(plugin)}
                  plugin={plugin}
                  busy={activeMutation === pluginKey(plugin)}
                  onToggle={(item, enabled) => toggle.mutate({ plugin: item, enabled })}
                  onUpdate={(item) => update.mutate(item)}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </SectionShell>
  );
}
