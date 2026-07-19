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
        <Button
          variant="ghost"
          size="sm"
          tone={server.enabled ? "success" : "neutral"}
          loading={toggling}
          leadingIcon={toggling ? undefined : <Power size={14} />}
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
          {testing ? null : <Zap size={15} />}
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
          <Trash2 size={15} />
        </Button>
      </div>
    </div>
  );
}
