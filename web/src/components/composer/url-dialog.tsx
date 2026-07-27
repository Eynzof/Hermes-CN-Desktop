import { useEffect, useRef, useState } from "react";
import { Globe, ImagePlus, Link2, X } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import {
  fetchLinkMetadata,
  isLikelyImageUrl,
  type LinkMetadata,
} from "@/lib/composer-url";
import { downloadExternalImageFile } from "@/lib/transport";
import s from "./url-dialog.module.css";

interface UrlDialogProps {
  open: boolean;
  url: string;
  /** Insert the URL as an `@url:<url>` reference (backend fetches content on send). */
  onInsertReference: () => void;
  /** Insert the raw URL as plain text. */
  onInsertPlain: () => void;
  /** Download the URL or rich preview image and add it as a composer attachment. */
  onAttachImage?: (url: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Shown when a bare URL is pasted into the composer. Previews the page <title>
 * (best-effort) and lets the user attach it as an `@url:` reference or drop it
 * in as plain text.
 */
export function UrlDialog({
  open,
  url,
  onInsertReference,
  onInsertPlain,
  onAttachImage,
  onCancel,
}: UrlDialogProps) {
  const [metadata, setMetadata] = useState<LinkMetadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState("");
  const [attachError, setAttachError] = useState("");
  const [attachingImage, setAttachingImage] = useState(false);
  const insertRef = useRef<HTMLButtonElement>(null);
  const previewSource = metadata?.imageUrl || (isLikelyImageUrl(url) ? url : metadata?.faviconUrl);

  useEffect(() => {
    if (!open || !url) return;
    let cancelled = false;
    setMetadata(null);
    setAttachError("");
    setLoadingMetadata(true);
    void fetchLinkMetadata(url).then((value) => {
      if (cancelled) return;
      setMetadata(value);
    }).finally(() => {
      if (cancelled) return;
      setLoadingMetadata(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  useEffect(() => {
    if (!open || !previewSource || typeof URL === "undefined") {
      setPreviewObjectUrl("");
      return;
    }

    let cancelled = false;
    let objectUrl = "";
    setPreviewObjectUrl("");
    void downloadExternalImageFile(previewSource)
      .then((file) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(file);
        setPreviewObjectUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewObjectUrl("");
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, previewSource]);

  if (!open || typeof document === "undefined") return null;

  const imageCandidate = isLikelyImageUrl(url) ? url : metadata?.imageUrl;
  const displayTitle = metadata?.title || (loadingMetadata ? "读取链接信息…" : "未能读取页面标题");
  const displayHost = metadata?.siteName || (() => {
    try {
      return new URL(metadata?.canonicalUrl || url).host;
    } catch {
      return "";
    }
  })();

  const attachImage = async () => {
    if (!imageCandidate || !onAttachImage) return;
    setAttachingImage(true);
    setAttachError("");
    try {
      await onAttachImage(imageCandidate);
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error || "添加图片失败"));
    } finally {
      setAttachingImage(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.backdrop} />
        <Dialog.Content
        className={s.modal}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          insertRef.current?.focus();
        }}
      >
        <div className={s.titleBar}>
          <Dialog.Title asChild>
            <h2>
              <Globe aria-hidden="true" />
              添加链接引用
            </h2>
          </Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className={s.close} aria-label="关闭">
              <X aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>
        <div className={s.body}>
          <div className={s.urlText}>{url}</div>
          <div className={s.previewCard}>
            {previewObjectUrl ? (
              <div className={s.previewImage} aria-hidden="true">
                <img src={previewObjectUrl} alt="" />
              </div>
            ) : (
              <div className={s.previewIcon} aria-hidden="true">
                <Globe />
              </div>
            )}
            <div className={s.previewMeta}>
              {displayHost ? <div className={s.previewSite}>{displayHost}</div> : null}
              <div className={s.titlePreview} data-muted={!metadata?.title || undefined}>
                {displayTitle}
              </div>
              {metadata?.description ? (
                <div className={s.previewDescription}>{metadata.description}</div>
              ) : null}
            </div>
          </div>
          {attachError ? <div className={s.errorText}>{attachError}</div> : null}
          <p className={s.hint}>
            插入为 <code>@url:</code> 引用后，发送时会自动抓取网页正文作为上下文。
          </p>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.secondary} onClick={onInsertPlain}>
            作为纯文本
          </button>
          {imageCandidate && onAttachImage ? (
            <button
              type="button"
              className={s.secondary}
              onClick={() => void attachImage()}
              disabled={attachingImage}
            >
              <ImagePlus aria-hidden="true" />
              {attachingImage ? "添加中…" : isLikelyImageUrl(url) ? "添加图片" : "添加预览图"}
            </button>
          ) : null}
          <button ref={insertRef} type="button" className={s.primary} onClick={onInsertReference}>
            <Link2 aria-hidden="true" />
            插入引用
          </button>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
