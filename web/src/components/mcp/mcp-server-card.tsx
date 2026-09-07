import { useMcpOAuth } from "@/hooks/use-mcp-oauth";
import { useConfirm } from "@/lib/use-confirm";
import { Badge, Button } from "@hermes/shared-ui";
import { Power, Trash2, Zap } from "lucide-react";
import type { McpServer, McpTestResult } from "@hermes/protocol";
import { transportTone } from "./parse";
import s from "./mcp.module.css";

export function McpServerCard({
  server,
  result,
  testing,
  toggling,
  onTest,
  onToggle,
  onDelete,
}: {
  server: McpServer;
  result?: McpTestResult;
  testing: boolean;
  toggling: boolean;
  onTest: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const oauth = useMcpOAuth(server.name);
  const { confirm } = useConfirm();
  const envCount = Object.keys(server.env ?? {}).length;
  const target =
    server.transport === "http"
      ? server.url ?? "—"
      : [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "—";

  return (
    <div className={`${s.card} ${!server.enabled ? s.cardDisabled : ""}`}>
      <div className={s.cardMain}>
        <div className={s.cardHead}>
          <span className={s.cardName}>{server.name}</span>
          <Badge tone={transportTone(server.transport)} variant="soft" size="sm">
            {server.transport}
          </Badge>
          {server.auth && (
            <Badge tone="info" variant="outline" size="sm">
              {server.auth}
            </Badge>
          )}
          {!server.enabled && (
            <Badge tone="neutral" variant="outline" size="sm">
              已禁用
            </Badge>
          )}
        </div>

        <div className={s.cardMetaRow}>
          <span className={s.cardMono}>{target}</span>
          {envCount > 0 && <span>{envCount} 个环境变量</span>}
        </div>

        {oauth.message && <p role="status">{oauth.message}</p>}
        {result && (
          result.ok ? (
            <p className={s.testOk}>
              {result.tools.length === 0
                ? "连接成功 · 未发现工具"
                : `工具（${result.tools.length}）：`}
              {result.tools.length > 0 && (
                <span className={s.toolNames}>
                  {result.tools.map((t) => t.name).join("、")}
                </span>
              )}
            </p>
          ) : (
            <p className={s.testErr}>{result.error ?? "连接失败"}</p>
          )
        )}
      </div>

      <div className={s.cardActions}>
        {server.transport === "http" && server.auth !== "header" && (
          oauth.authorizing ? (
            <Button size="sm" variant="outline" onClick={() => void oauth.cancel()}>取消授权</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={oauth.busy} onClick={() => void oauth.authorize().then(ok => { if (ok) onTest(); })}>
              {server.auth === "oauth" ? "重新授权" : "OAuth 授权"}
            </Button>
          )
        )}
        {server.auth === "oauth" && !oauth.busy && (
          <Button size="sm" variant="outline" onClick={() => void confirm({
            title: "退出 MCP 登录", body: "将清除本机保存的登录凭证、禁用该服务并刷新 MCP 连接。", confirmLabel: "退出登录", danger: true,
          }).then(ok => { if (ok) void oauth.logout(); })}>退出登录</Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          tone={server.enabled ? "success" : "neutral"}
          loading={toggling}
          leadingIcon={toggling ? undefined : <Power size={16} />}
          onClick={onToggle}
        >
          {server.enabled ? "禁用" : "启用"}
        </Button>
        <Button
          iconOnly
          variant="ghost"
          size="sm"
          aria-label="测试连接"
          title="测试连接"
          loading={testing}
          onClick={onTest}
        >
          {testing ? null : <Zap size={16} />}
        </Button>
        <Button
          iconOnly
          variant="ghost"
          tone="danger"
          size="sm"
          aria-label="删除"
          title="删除"
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </Button>
      </div>
    </div>
  );
}
