import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Globe, Link2, X } from "lucide-react";
import { fetchUrlTitle } from "@/lib/composer-url";
import s from "./url-dialog.module.css";

interface UrlDialogProps {
  open: boolean;
  url: string;
  /** Insert the URL as an `@url:<url>` reference (backend fetches content on send). */
  onInsertReference: () => void;
  /** Insert the raw URL as plain text. */
  onInsertPlain: () => void;
  onCancel: () => void;
}

/**
 * Shown when a bare URL is pasted into the composer. Previews the page <title>
 * (best-effort) and lets the user attach it as an `@url:` reference or drop it
 * in as plain text.
 */
export function UrlDialog({ open, url, onInsertReference, onInsertPlain, onCancel }: UrlDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [loadingTitle, setLoadingTitle] = useState(false);
  const insertRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || !url) return;
    let cancelled = false;
    setTitle("");
    setLoadingTitle(true);
    void fetchUrlTitle(url).then((value) => {
      if (cancelled) return;
      setTitle(value);
      setLoadingTitle(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  useEffect(() => {
    if (!open) return;
    insertRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onInsertReference();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onInsertReference]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={s.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={s.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.titleBar}>
          <h2 id={titleId}>
            <Globe aria-hidden="true" />
            添加链接引用
          </h2>
          <button type="button" className={s.close} onClick={onCancel} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        </div>
        <div className={s.body}>
          <div className={s.urlText}>{url}</div>
          <div className={s.titlePreview} data-muted={!title || undefined}>
            {loadingTitle ? "读取标题…" : title || "（未能读取页面标题）"}
          </div>
          <p className={s.hint}>
            插入为 <code>@url:</code> 引用后，发送时会自动抓取网页正文作为上下文。
          </p>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.secondary} onClick={onInsertPlain}>
            作为纯文本
          </button>
          <button ref={insertRef} type="button" className={s.primary} onClick={onInsertReference}>
            <Link2 aria-hidden="true" />
            插入引用
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
