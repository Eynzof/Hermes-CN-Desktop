import { useState } from "react";
import { Button } from "@hermes/shared-ui";
import { useRemoveMcpServer } from "@/hooks/use-mcp";
import { McpDialogShell } from "./mcp-dialog-shell";
import { errText } from "./parse";
import s from "./mcp.module.css";

export function McpDeleteDialog({
  name,
  onClose,
  onDeleted,
}: {
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useRemoveMcpServer();
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    remove.mutate(name, {
      onSuccess: () => {
        onDeleted();
        onClose();
      },
      onError: (err) => setError(errText(err)),
    });
  };

  return (
    <McpDialogShell
      open
      title="删除 MCP 服务"
      busy={remove.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
            取消
          </Button>
          <Button variant="solid" tone="danger" onClick={confirm} loading={remove.isPending}>
            确认删除
          </Button>
        </>
      }
    >
      <p className={s.intro}>
        将从配置中移除服务 <code>{name}</code>。其工具会在重载后从对话中消失，可随时重新添加。
      </p>
      {error && <div className={s.formError}>{error}</div>}
    </McpDialogShell>
  );
}
