import { useEffect, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import { isLikelyLocalFilePath, safeImageSrc } from "@/lib/message-images";
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
      <ImageOff size={18} strokeWidth={1.8} aria-hidden="true" />
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

  return (
    <a
      className={s.imageFrame}
      href={src}
      target="_blank"
      rel="noreferrer"
      title={image.title || label}
    >
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
      />
    </a>
  );
}
