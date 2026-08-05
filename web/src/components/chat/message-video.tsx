import { useEffect, useMemo, useState } from "react";
import { VideoOff } from "lucide-react";
import { isLikelyLocalFilePath } from "@/lib/message-images";
import { safeVideoSrc, videoSourceNeedsConsent } from "@/lib/message-media";
import { fetchMediaDataUrl, mediaStreamUrl } from "@/lib/transport";
import type { ChatVideoItem } from "./chat-types";
import s from "./message-timeline.module.css";

interface MessageVideoProps {
  video: ChatVideoItem;
}

export function resolveVideoStreamSource(
  localPath: string | undefined,
  failedStreamSrc: string | undefined,
): { streamSrc?: string; activeStreamSrc?: string } {
  const streamSrc = localPath ? mediaStreamUrl(localPath) : undefined;
  return {
    streamSrc,
    activeStreamSrc: failedStreamSrc === streamSrc ? undefined : streamSrc,
  };
}

function videoLabel(video: ChatVideoItem): string {
  return video.title || video.name || "视频";
}

function visibleSource(value: string): string {
  if (value.length <= 96) return value;
  return `${value.slice(0, 48)}...${value.slice(-28)}`;
}

function VideoPlaceholder({
  video,
  reason,
  onLoadExternal,
}: {
  video: ChatVideoItem;
  reason: "loading" | "unsupported" | "failed" | "external";
  onLoadExternal?: () => void;
}) {
  const label = videoLabel(video);
  const source = video.url?.trim();
  const safe = safeVideoSrc(source);

  return (
    <div className={s.videoFallback} role={reason === "failed" ? "alert" : "status"}>
      <VideoOff size={20} strokeWidth={1.8} aria-hidden="true" />
      <span className={s.videoFallbackBody}>
        <span className={s.videoFallbackTitle}>
          {reason === "loading"
            ? "视频加载中"
            : reason === "external"
              ? "外部视频已阻止自动加载"
            : reason === "failed"
              ? "视频加载失败"
              : "视频暂不能直接播放"}
        </span>
        <span className={s.videoFallbackMeta}>{label}</span>
        {source ? (
          safe ? (
            <span className={s.videoFallbackActions}>
              {reason === "external" && onLoadExternal ? (
                <button type="button" onClick={onLoadExternal}>加载并播放</button>
              ) : null}
              <a href={safe} target="_blank" rel="noreferrer" title={source}>
                打开视频
              </a>
            </span>
          ) : (
            <code title={source}>{visibleSource(source)}</code>
          )
        ) : null}
      </span>
    </div>
  );
}

export function MessageVideo({ video }: MessageVideoProps) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const [failedStreamSrc, setFailedStreamSrc] = useState<string>();
  const [approvedDirectSrc, setApprovedDirectSrc] = useState<string>();
  const [localVideo, setLocalVideo] = useState<{
    path: string;
    src?: string;
    failed?: boolean;
  }>();
  const directSrc = useMemo(() => safeVideoSrc(video.url), [video.url]);
  const directNeedsConsent = Boolean(directSrc && videoSourceNeedsConsent(directSrc));
  const activeDirectSrc = directNeedsConsent && approvedDirectSrc !== directSrc
    ? undefined
    : directSrc;
  const localPath = useMemo(() => {
    const source = video.url?.trim();
    return !directSrc && source && isLikelyLocalFilePath(source) ? source : undefined;
  }, [directSrc, video.url]);
  // Runtime URL and session token can rotate after a managed-runtime restart or
  // profile switch. Recompute on every render and key failures by the complete
  // authenticated URL so the same file path can retry with fresh credentials.
  const { activeStreamSrc } = resolveVideoStreamSource(localPath, failedStreamSrc);

  useEffect(() => {
    if (!localPath || activeStreamSrc) {
      setLocalVideo(undefined);
      return;
    }

    let active = true;
    setLocalVideo({ path: localPath });
    void fetchMediaDataUrl(localPath).then((dataUrl) => {
      if (!active) return;
      const src = safeVideoSrc(dataUrl);
      setLocalVideo(src ? { path: localPath, src } : { path: localPath, failed: true });
    }).catch(() => {
      if (active) setLocalVideo({ path: localPath, failed: true });
    });
    return () => {
      active = false;
    };
  }, [activeStreamSrc, localPath]);

  const resolvedLocal = localVideo?.path === localPath ? localVideo : undefined;
  if (directSrc && directNeedsConsent && !activeDirectSrc) {
    return (
      <VideoPlaceholder
        video={video}
        reason="external"
        onLoadExternal={() => setApprovedDirectSrc(directSrc)}
      />
    );
  }

  const src = activeDirectSrc || activeStreamSrc || resolvedLocal?.src;

  if (localPath && !resolvedLocal?.failed && !src) {
    return <VideoPlaceholder video={video} reason="loading" />;
  }
  if (!src) {
    return <VideoPlaceholder video={video} reason={resolvedLocal?.failed ? "failed" : "unsupported"} />;
  }
  if (failedSrc === src) return <VideoPlaceholder video={video} reason="failed" />;

  return (
    <div className={s.videoFrame} title={video.title || videoLabel(video)}>
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={videoLabel(video)}
        onError={() => {
          if (activeStreamSrc && src === activeStreamSrc && localPath) {
            setFailedStreamSrc(activeStreamSrc);
            return;
          }
          setFailedSrc(src);
        }}
      />
    </div>
  );
}
