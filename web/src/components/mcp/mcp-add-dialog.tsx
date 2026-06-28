import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@hermes/shared-ui";
import type { McpServerCreate } from "@hermes/protocol";
import { useAddMcpServer } from "@/hooks/use-mcp";
import { McpDialogShell } from "./mcp-dialog-shell";
import { errText, parseArgs, parseEnv } from "./parse";
import s from "./mcp.module.css";

type Transport = "http" | "stdio";

export function McpAddDialog({
  existingNames,
  onClose,
  onSaved,
}: {
  existingNames: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const add = useAddMcpServer();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请填写服务名称");
      return;
    }
    if (existingNames.includes(trimmed)) {
      setError("已存在同名服务");
      return;
    }
    if (transport === "http" && !url.trim()) {
      setError("HTTP/SSE 服务需要填写 URL");
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setError("stdio 服务需要填写命令");
      return;
    }

    const body: McpServerCreate = { name: trimmed };
    if (transport === "http") {
      body.url = url.trim();
    } else {
      body.command = command.trim();
      const argList = parseArgs(args);
      if (argList.length) body.args = argList;
    }
    const envMap = parseEnv(env);
    if (Object.keys(envMap).length) body.env = envMap;

    add.mutate(body, {
      onSuccess: () => {
        onSaved();
        onClose();
      },
      onError: (err) => setError(errText(err)),
    });
  };

  return (
    <McpDialogShell
      open
      title="添加 MCP 服务"
      busy={add.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={add.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={submit}
            loading={add.isPending}
            disabled={name.trim().length === 0}
          >
            添加
          </Button>
        </>
      }
    >
      <Field label="名称" required hint="字母 / 数字 / - / _，用于在工具名中标识该服务。">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 filesystem"
          mono
          autoFocus
          disabled={add.isPending}
        />
      </Field>

      <Field label="传输方式">
        <Select
          value={transport}
          onChange={(e) => setTransport(e.target.value as Transport)}
          disabled={add.isPending}
        >
          <option value="http">HTTP / SSE（远程服务）</option>
          <option value="stdio">stdio（本地命令）</option>
        </Select>
      </Field>

      {transport === "http" ? (
        <Field label="URL" required>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            mono
            disabled={add.isPending}
          />
        </Field>
      ) : (
        <>
          <Field label="命令" required>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              mono
              disabled={add.isPending}
            />
          </Field>
          <Field label="参数（可选）" hint="按空格或逗号分隔。">
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              mono
              disabled={add.isPending}
            />
          </Field>
        </>
      )}

      <Field label="环境变量（可选）" hint="每行一个 KEY=VALUE，写入服务配置（如 API key）。">
        <Textarea
          className={s.envArea}
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          placeholder={"API_KEY=secret\nDEBUG=1"}
          disabled={add.isPending}
        />
      </Field>

      {error && <div className={s.formError}>{error}</div>}
    </McpDialogShell>
  );
}
