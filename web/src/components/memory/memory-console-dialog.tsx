import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button, Dialog, Input } from "@hermes/shared-ui";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";
import { normalizeExternalUrl, openExternalUrl } from "@/lib/external-links";
import { MEMORY_BACKEND_META } from "./memory-backend-utils";
import s from "./memory-backends.module.css";

const DEFAULT_CONSOLE_URLS: Record<VisibleMemoryProvider, string> = {
  openviking: "http://127.0.0.1:1933/studio",
  hindsight: "http://localhost:9999/dashboard",
};

export function resolveMemoryConsoleUrl(provider: VisibleMemoryProvider, consoleUrl?: string): string {
  return consoleUrl?.trim() || DEFAULT_CONSOLE_URLS[provider];
}

interface Props {
  provider: VisibleMemoryProvider;
  consoleUrl?: string;
}

function normalizeConsoleUrl(value: string): string | null {
  const normalized = normalizeExternalUrl(value);
  if (!normalized) return null;
  return normalized.startsWith("http://") || normalized.startsWith("https://") ? normalized : null;
}

export function MemoryConsoleDialog({ provider, consoleUrl }: Props) {
  const meta = MEMORY_BACKEND_META[provider];
  const defaultUrl = resolveMemoryConsoleUrl(provider, consoleUrl);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(defaultUrl);
  const [error, setError] = useState("");

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setValue(defaultUrl);
      setError("");
    }
    setOpen(next);
  };

  const handleSubmit = () => {
    const normalized = normalizeConsoleUrl(value);
    if (!normalized) {
      setError("请输入有效的 http:// 或 https:// 控制台地址。");
      return;
    }
    setOpen(false);
    void openExternalUrl(normalized);
  };

  const descriptionId = `${provider}-console-description`;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="plain" size="sm">
          {meta.label} 控制台 <ExternalLink size={12} />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.consoleDialog} aria-describedby={descriptionId}>
          <Dialog.Title className={s.consoleDialogTitle}>{meta.label} 控制台</Dialog.Title>
          <Dialog.Description id={descriptionId} className={s.consoleDialogDescription}>
            此功能需要先在本地部署并启动 {meta.label} 才可以使用。确认或修改控制台 URL 后，将在系统浏览器中打开。
          </Dialog.Description>
          <label className={s.consoleUrlField}>
            <span>控制台 URL</span>
            <Input
              type="url"
              value={value}
              autoFocus
              invalid={Boolean(error)}
              onChange={(event) => {
                setValue(event.target.value);
                setError("");
              }}
            />
          </label>
          {error && <div className={s.consoleUrlError}>{error}</div>}
          <div className={s.consoleDialogActions}>
            <Dialog.Close asChild>
              <Button type="button" variant="outline">取消</Button>
            </Dialog.Close>
            <Button type="button" variant="solid" tone="accent" onClick={handleSubmit}>
              打开控制台 <ExternalLink size={12} />
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
