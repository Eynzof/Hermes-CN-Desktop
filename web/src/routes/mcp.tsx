import { useCallback, useState } from "react";
import { Button } from "@hermes/shared-ui";
import { Package, Plus, RefreshCw, Server } from "lucide-react";
import type { McpCatalogEntry, McpServer, McpTestResult } from "@hermes/protocol";
import {
  reloadMcp,
  useInstallCatalogEntry,
  useMcpCatalog,
  useMcpServersFull,
  useSetMcpEnabled,
  useTestMcpServer,
} from "@/hooks/use-mcp";
import {
  McpAddDialog,
  McpCatalogCard,
  McpDeleteDialog,
  McpInstallDialog,
  McpServerCard,
} from "@/components/mcp";
import { errText } from "@/components/mcp/parse";
import { SectionShell } from "./section-shell";
import s from "./mcp.module.css";

type Editor =
  | { kind: "add" }
  | { kind: "install"; entry: McpCatalogEntry }
  | { kind: "delete"; name: string };

type Notice = { tone: "ok" | "warn" | "err"; text: string };

export function McpRoute() {
  const serversQuery = useMcpServersFull();
  const catalogQuery = useMcpCatalog();
  const setEnabled = useSetMcpEnabled();
  const testMut = useTestMcpServer();
  const installMut = useInstallCatalogEntry();

  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});
  const [testingName, setTestingName] = useState<string | null>(null);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const servers = serversQuery.data ?? [];
  const isError = serversQuery.isError;
  const isLoading = serversQuery.isLoading;
  const enabledCount = servers.filter((srv) => srv.enabled).length;

  const sub = isError
    ? "未接入"
    : serversQuery.data
      ? `${enabledCount} / ${servers.length} 启用`
      : isLoading
        ? "加载中…"
        : "—";

  // 增删改后调用官方 reload.mcp 让改动即时生效；失败不阻断操作，仅降级提示。
  const runReload = useCallback(async (okText: string) => {
    setReloading(true);
    try {
      const r = await reloadMcp();
      // 正常返回 { status: "reloaded" }；若服务端开了确认门则返回
      // confirm_required（理论上 confirm:true 已跳过）。其余已解析的返回都按成功处理。
      if (r?.status === "confirm_required") {
        setNotice({
          tone: "warn",
          text: "配置已保存。即时重载需要确认，重启 dashboard 或下次会话后生效。",
        });
      } else {
        setNotice({ tone: "ok", text: okText });
      }
    } catch {
      setNotice({
        tone: "warn",
        text: "配置已保存，但即时重载未成功；重启 dashboard 或下次会话后生效。",
      });
    } finally {
      setReloading(false);
    }
  }, []);

  const handleToggle = (server: McpServer) => {
    const next = !server.enabled;
    setTogglingName(server.name);
    setEnabled.mutate(
      { name: server.name, enabled: next },
      {
        onSuccess: () => runReload(`已${next ? "启用" : "禁用"} ${server.name}`),
        onError: (err) => setNotice({ tone: "err", text: errText(err) }),
        onSettled: () => setTogglingName(null),
      },
    );
  };

  const handleTest = (server: McpServer) => {
    setTestingName(server.name);
    testMut.mutate(server.name, {
      onSuccess: (res) => {
        setTestResults((prev) => ({ ...prev, [server.name]: res }));
        if (!res.ok) setNotice({ tone: "err", text: `${server.name}：${res.error ?? "连接失败"}` });
      },
      onError: (err) => setNotice({ tone: "err", text: errText(err) }),
      onSettled: () => setTestingName(null),
    });
  };

  const handleInstallClick = (entry: McpCatalogEntry) => {
    if (entry.required_env.length > 0) {
      setEditor({ kind: "install", entry });
      return;
    }
    setInstallingName(entry.name);
    installMut.mutate(
      { name: entry.name, enable: true },
      {
        onSuccess: (res) =>
          res.background
            ? setNotice({ tone: "ok", text: `${entry.name} 正在后台安装…` })
            : runReload(`已安装 ${entry.name}`),
        onError: (err) => setNotice({ tone: "err", text: errText(err) }),
        onSettled: () => setInstallingName(null),
      },
    );
  };

  const catalog = catalogQuery.data?.entries ?? [];
  const diagnosticsByName: Record<string, string[]> = {};
  (catalogQuery.data?.diagnostics ?? []).forEach((d) => {
    (diagnosticsByName[d.name] ??= []).push(d.message);
  });

  return (
    <SectionShell
      title="MCP 服务"
      sub={sub}
      right={
        !isError ? (
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button
              variant="outline"
              size="sm"
              leadingIcon={<RefreshCw size={14} />}
              loading={reloading}
              onClick={() => runReload("已重新载入 MCP")}
            >
              重新载入
            </Button>
            <Button
              variant="solid"
              tone="accent"
              size="sm"
              leadingIcon={<Plus size={14} />}
              onClick={() => setEditor({ kind: "add" })}
            >
              添加服务
            </Button>
          </span>
        ) : undefined
      }
    >
      <p className={s.desc}>
        Model Context Protocol 服务由 Hermes 网关托管。在这里添加、启停、测试服务，或从官方目录一键安装；改动通过官方 reload 即时生效，无需手改配置或重启。
      </p>

      {notice && (
        <div className={s.notice} data-tone={notice.tone}>
          <span>{notice.text}</span>
          <button type="button" className={s.noticeDismiss} onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* ── 我的 MCP 服务 ── */}
      <div className={s.sectionHead}>
        <Server size={15} />
        <span className={s.sectionTitle}>我的 MCP 服务</span>
        {!isError && serversQuery.data && (
          <span className={s.sectionCount}>{servers.length}</span>
        )}
      </div>

      {isError ? (
        <div className={s.errorState}>
          <strong>无法读取 MCP 服务。</strong>
          <p>
            {serversQuery.error instanceof Error ? serversQuery.error.message : "未知错误"}
            。常见原因是 dashboard 启动早于 gateway，重启 dashboard 即可。
          </p>
        </div>
      ) : isLoading ? (
        <div className={s.emptyState}>加载中…</div>
      ) : servers.length === 0 ? (
        <div className={s.emptyState}>
          还没有任何 MCP 服务。点右上角「添加服务」，或从下方目录一键安装。
        </div>
      ) : (
        <div className={s.list}>
          {servers.map((server) => (
            <McpServerCard
              key={server.name}
              server={server}
              result={testResults[server.name]}
              testing={testingName === server.name}
              toggling={togglingName === server.name}
              onTest={() => handleTest(server)}
              onToggle={() => handleToggle(server)}
              onDelete={() => setEditor({ kind: "delete", name: server.name })}
            />
          ))}
        </div>
      )}

      {/* ── 服务目录 ── */}
      <div className={s.sectionHead}>
        <Package size={15} />
        <span className={s.sectionTitle}>服务目录</span>
        {catalogQuery.data && <span className={s.sectionCount}>{catalog.length}</span>}
      </div>
      <p className={s.sectionDesc}>浏览官方审核过的 MCP 服务，一键安装。</p>

      {catalogQuery.isError ? (
        <div className={s.emptyState}>目录暂不可用。</div>
      ) : catalogQuery.isLoading ? (
        <div className={s.emptyState}>加载中…</div>
      ) : catalog.length === 0 ? (
        <div className={s.emptyState}>目录暂无可用条目。</div>
      ) : (
        <div className={s.list}>
          {catalog.map((entry) => (
            <McpCatalogCard
              key={entry.name}
              entry={entry}
              diagnostics={diagnosticsByName[entry.name] ?? []}
              installing={installingName === entry.name}
              onInstall={() => handleInstallClick(entry)}
            />
          ))}
        </div>
      )}

      {editor?.kind === "add" && (
        <McpAddDialog
          existingNames={servers.map((srv) => srv.name)}
          onClose={() => setEditor(null)}
          onSaved={() => runReload("已添加服务并重新载入")}
        />
      )}
      {editor?.kind === "install" && (
        <McpInstallDialog
          entry={editor.entry}
          onClose={() => setEditor(null)}
          onInstalled={(background) =>
            background
              ? setNotice({ tone: "ok", text: `${editor.entry.name} 正在后台安装…` })
              : runReload(`已安装 ${editor.entry.name}`)
          }
        />
      )}
      {editor?.kind === "delete" && (
        <McpDeleteDialog
          name={editor.name}
          onClose={() => setEditor(null)}
          onDeleted={() => {
            setTestResults((prev) => {
              const next = { ...prev };
              delete next[editor.name];
              return next;
            });
            void runReload(`已删除 ${editor.name}`);
          }}
        />
      )}
    </SectionShell>
  );
}
