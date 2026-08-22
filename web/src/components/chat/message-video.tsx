import { useEffect, useMemo, useState } from "react";
import { Film } from "lucide-react";
import { fetchMediaDataUrl } from "@/lib/transport";
import { isLikelyLocalFilePath, normalizeLocalFilePath } from "@/lib/message-images";
import type { ChatVideoItem } from "./chat-types";
import s from "./message-timeline.module.css";

interface MessageVideoProps {
  video: ChatVideoItem;
}

function videoLabel(video: ChatVideoItem): string {
  return video.name || video.title || "视频";
}

function visibleSource(value: string): string {
  if (value.length <= 96) return value;
  return `${value.slice(0, 48)}…${value.slice(-28)}`;
}

function VideoPlaceholder({
  video,
  reason,
}: {
  video: ChatVideoItem;
  reason: "loading" | "failed";
}) {
  const label = videoLabel(video);
  const source = video.url?.trim();
  return (
    <div className={s.imageFallback} role={reason === "failed" ? "alert" : "status"}>
      <Film size={20} strokeWidth={1.8} aria-hidden="true" />
      <span className={s.imageFallbackBody}>
        <span className={s.imageFallbackTitle}>
          {reason === "loading" ? "视频加载中" : "视频加载失败"}
        </span>
        <span className={s.imageFallbackMeta}>{label}</span>
        {source ? <code title={source}>{visibleSource(source)}</code> : null}
      </span>
    </div>
  );
}

export function MessageVideo({ video }: MessageVideoProps) {
  const [localSrc, setLocalSrc] = useState<string>();
  const [localFailed, setLocalFailed] = useState(false);

  const directSrc = useMemo(() => {
    const source = video.url?.trim();
    if (!source) return undefined;
    if (/^(?:https?|data|blob):/i.test(source)) return source;
    return undefined;
  }, [video.url]);

  const localPath = useMemo(() => {
    const source = video.url?.trim();
    return !directSrc && source && isLikelyLocalFilePath(source) ? normalizeLocalFilePath(source) : undefined;
  }, [directSrc, video.url]);

  useEffect(() => {
    if (!localPath) {
      setLocalSrc(undefined);
      setLocalFailed(false);
      return;
    }
    let active = true;
    void fetchMediaDataUrl(localPath).then((url) => {
      if (!active) return;
      if (url) setLocalSrc(url);
      else setLocalFailed(true);
    }).catch(() => {
      if (active) setLocalFailed(true);
    });
    return () => {
      active = false;
    };
  }, [localPath]);

  const src = directSrc || localSrc;

  if (localPath && !src && !localFailed) {
    return <VideoPlaceholder video={video} reason="loading" />;
  }
  if (!src) {
    return <VideoPlaceholder video={video} reason="failed" />;
  }

  return (
    <div className={s.videoFrame}>
      <video
        src={src}
        controls
        preload="metadata"
        poster={video.poster}
        aria-label={videoLabel(video)}
        onError={() => setLocalFailed(true)}
      />
    </div>
  );
}
