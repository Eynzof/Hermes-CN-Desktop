import { useState } from "react";
import { Button, Field, Input } from "@hermes/shared-ui";
import type { McpCatalogEntry } from "@hermes/protocol";
import { useInstallCatalogEntry } from "@/hooks/use-mcp";
import { McpDialogShell } from "./mcp-dialog-shell";
import { errText } from "./parse";
import s from "./mcp.module.css";

// 目录项声明了 required_env 时弹出，收集这些值后再安装。
export function McpInstallDialog({
  entry,
  onClose,
  onInstalled,
}: {
  entry: McpCatalogEntry;
  onClose: () => void;
  onInstalled: (background: boolean) => void;
}) {
  const install = useInstallCatalogEntry();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    entry.required_env.forEach((item) => {
      init[item.name] = "";
    });
    return init;
  });
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const missing = entry.required_env.find(
      (item) => item.required && !(values[item.name] ?? "").trim(),
    );
    if (missing) {
      setError(`请填写「${missing.prompt || missing.name}」`);
      return;
    }
    const envMap: Record<string, string> = {};
    Object.entries(values).forEach(([k, v]) => {
      if (v.trim()) envMap[k] = v.trim();
    });

    install.mutate(
      { name: entry.name, env: envMap, enable: true },
      {
        onSuccess: (res) => {
          onInstalled(Boolean(res.background));
          onClose();
        },
        onError: (err) => setError(errText(err)),
      },
    );
  };

  return (
    <McpDialogShell
      open
      title={`安装 ${entry.name}`}
      busy={install.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={install.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={submit}
            loading={install.isPending}
          >
            安装
          </Button>
        </>
      }
    >
      <p className={s.intro}>该服务需要先配置以下值才能使用。</p>
      {entry.required_env.map((item) => (
        <Field
          key={item.name}
          label={item.prompt || item.name}
          required={item.required}
        >
          <Input
            type="password"
            value={values[item.name] ?? ""}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [item.name]: e.target.value }))
            }
            placeholder={item.name}
            mono
            disabled={install.isPending}
          />
        </Field>
      ))}
      {error && <div className={s.formError}>{error}</div>}
    </McpDialogShell>
  );
}
