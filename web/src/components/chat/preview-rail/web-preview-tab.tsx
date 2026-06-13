import { useEffect, useState } from "react";
import { Globe, RotateCw } from "lucide-react";
import { isPreviewableUrl } from "@/lib/preview-rail";
import s from "./preview-rail.module.css";

interface WebPreviewTabProps {
  /** Committed URL loaded in the iframe (persisted per session by the rail). */
  url: string;
  onUrlChange: (url: string) => void;
}

// Sandboxed web preview. `frame-src` in tauri.conf.json must allow the target
// origin (local dev servers: http://localhost:* / http://127.0.0.1:*).
export function WebPreviewTab({ url, onUrlChange }: WebPreviewTabProps) {
  const [draft, setDraft] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setDraft(url);
  }, [url]);

  const valid = isPreviewableUrl(draft);

  const load = () => {
    if (!valid) return;
    onUrlChange(draft.trim());
    setReloadKey((k) => k + 1);
  };

  return (
    <>
      <div className={s.bar}>
        <input
          className={s.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load();
          }}
          placeholder="http://127.0.0.1:5173"
          aria-label="预览网址"
          spellCheck={false}
        />
        <button type="button" className={s.iconBtn} onClick={load} disabled={!valid}>
          <Globe size={13} aria-hidden />
          打开
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={!url}
          title="刷新"
          aria-label="刷新预览"
        >
          <RotateCw size={13} aria-hidden />
        </button>
      </div>
      {url ? (
        <iframe
          key={`${url}#${reloadKey}`}
          className={s.iframe}
          src={url}
          title="网页预览"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className={s.empty}>
          <Globe size={24} aria-hidden />
          <p>输入一个本地预览地址（如开发服务器 http://127.0.0.1:5173），在右栏内嵌打开。</p>
        </div>
      )}
    </>
  );
}
