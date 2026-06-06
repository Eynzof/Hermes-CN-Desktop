import { useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import { safeImageSrc } from "@/lib/message-images";
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
  reason: "unsupported" | "failed";
}) {
  const label = imageLabel(image);
  const source = image.url?.trim();
  const safe = safeImageSrc(source);

  return (
    <div className={s.imageFallback} role={reason === "failed" ? "alert" : "status"}>
      <ImageOff size={18} strokeWidth={1.8} aria-hidden="true" />
      <span className={s.imageFallbackBody}>
        <span className={s.imageFallbackTitle}>
          {reason === "failed" ? "图片加载失败" : "图片暂不能直接预览"}
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
  const [failed, setFailed] = useState(false);
  const src = useMemo(() => safeImageSrc(image.url), [image.url]);
  const label = imageLabel(image);

  if (!src) return <ImagePlaceholder image={image} reason="unsupported" />;
  if (failed) return <ImagePlaceholder image={image} reason="failed" />;

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
        onError={() => setFailed(true)}
      />
    </a>
  );
}
