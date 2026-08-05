import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@hermes/shared-ui";
import { ExternalLink, FolderOpen, ImageOff, X } from "lucide-react";
import { isLikelyLocalFilePath, safeImageSrc } from "@/lib/message-images";
import { openExternalUrl } from "@/lib/external-links";
import { fetchMediaDataUrl } from "@/lib/transport";
import type { ChatImageItem } from "./chat-types";
import s from "./message-timeline.module.css";

interface MessageImageProps {
  image: ChatImageItem;
}

function imageLabel(image: ChatImageItem): string {
  return image.alt || image.name || image.title || "图片";
}

function visibleSource(value: string): string {
  if (value.length <= 96) return value;
  return `${value.slice(0, 48)}…${value.slice(-28)}`;
}

function containingFolder(path: string): string | undefined {
  const value = path.trim().replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separatorIndex < 0) return undefined;
  if (separatorIndex === 0) return value.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(value)) {
    return value.slice(0, 3);
  }
  return value.slice(0, separatorIndex);
}

function ImagePlaceholder({
  image,
  reason,
}: {
  image: ChatImageItem;
  reason: "loading" | "unsupported" | "failed";
}) {
  const label = imageLabel(image);
  const source = image.url?.trim();
  const safe = safeImageSrc(source);

  return (
    <div className={s.imageFallback} role={reason === "failed" ? "alert" : "status"}>
      <ImageOff size={20} strokeWidth={1.8} aria-hidden="true" />
      <span className={s.imageFallbackBody}>
        <span className={s.imageFallbackTitle}>
          {reason === "loading"
            ? "图片加载中"
            : reason === "failed"
              ? "图片加载失败"
              : "图片暂不能直接预览"}
        </span>
        <span className={s.imageFallbackMeta}>{label}</span>
        {source ? (
          safe ? (
            <a href={safe} target="_blank" rel="noreferrer" title={source}>
              打开原图
            </a>
          ) : (
            <code title={source}>{visibleSource(source)}</code>
          )
        ) : null}
      </span>
    </div>
  );
}

export function MessageImage({ image }: MessageImageProps) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [openOriginalFailed, setOpenOriginalFailed] = useState(false);
  const [localImage, setLocalImage] = useState<{
    path: string;
    src?: string;
    failed?: boolean;
  }>();
  const directSrc = useMemo(() => safeImageSrc(image.url), [image.url]);
  const localPath = useMemo(() => {
    const source = image.url?.trim();
    return !directSrc && source && isLikelyLocalFilePath(source) ? source : undefined;
  }, [directSrc, image.url]);
  const label = imageLabel(image);

  useEffect(() => {
    if (!localPath) {
      setLocalImage(undefined);
      return;
    }

    let active = true;
    setLocalImage({ path: localPath });
    void fetchMediaDataUrl(localPath).then((dataUrl) => {
      if (!active) return;
      const src = safeImageSrc(dataUrl);
      setLocalImage(src ? { path: localPath, src } : { path: localPath, failed: true });
    }).catch(() => {
      if (active) setLocalImage({ path: localPath, failed: true });
    });
    return () => {
      active = false;
    };
  }, [localPath]);

  const resolvedLocal = localImage?.path === localPath ? localImage : undefined;
  const src = directSrc || resolvedLocal?.src;

  if (localPath && !resolvedLocal?.failed && !src) {
    return <ImagePlaceholder image={image} reason="loading" />;
  }
  if (!src) {
    return <ImagePlaceholder image={image} reason={resolvedLocal?.failed ? "failed" : "unsupported"} />;
  }
  if (failedSrc === src) return <ImagePlaceholder image={image} reason="failed" />;

  const openOriginal = async () => {
    setOpenOriginalFailed(false);
    try {
      if (localPath && window.hermesDesktop?.openWorkspacePath) {
        const folder = containingFolder(localPath);
        if (folder) {
          const result = await window.hermesDesktop.openWorkspacePath({ path: folder });
          if (result.ok) {
            setPreviewOpen(false);
            return;
          }
        }
      } else if (/^https?:/i.test(src) && await openExternalUrl(src)) {
        return;
      } else if (typeof window !== "undefined") {
        const opened = window.open(src, "_blank", "noopener,noreferrer");
        if (opened) return;
      }
    } catch {
      // Surface a compact failure state in the toolbar below.
    }
    setOpenOriginalFailed(true);
  };

  return (
    <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={s.imageFrame}
          title={`放大查看：${image.title || label}`}
          aria-label={`放大查看图片：${label}`}
        >
          <img
            src={src}
            alt={label}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSrc(src)}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={s.imageLightboxOverlay} />
        <Dialog.Content className={s.imageLightbox}>
          <Dialog.Title className={s.imageLightboxTitle}>{label}</Dialog.Title>
          <Dialog.Description className={s.imageLightboxDescription}>
            图片大图预览
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button" className={s.imageLightboxClose} aria-label="关闭图片预览" title="关闭">
              <X size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </Dialog.Close>
          <div className={s.imageLightboxCanvas}>
            <img src={src} alt={label} />
          </div>
          <div className={s.imageLightboxFooter}>
            <span title={label}>{label}</span>
            <button
              type="button"
              onClick={() => void openOriginal()}
              title={localPath ? "在 Finder 中打开图片所在文件夹" : "在系统浏览器打开原图地址"}
            >
              {localPath
                ? <FolderOpen size={16} aria-hidden="true" />
                : <ExternalLink size={16} aria-hidden="true" />}
              {openOriginalFailed ? "打开失败" : localPath ? "打开所在文件夹" : "打开原图"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
