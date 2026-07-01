import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Copy, ExternalLink, MessageSquare } from "lucide-react";
import { fetchRecentArtifacts, type ArtifactKind, type ArtifactRecord } from "@/lib/artifacts";
import { SectionShell } from "./section-shell";
import s from "./artifacts.module.css";

type Filter = "all" | ArtifactKind;

function canPreviewImage(value: string): boolean {
  return value.startsWith("data:image/") || /^https?:\/\//.test(value) || /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(value);
}

function matches(item: ArtifactRecord, query: string, filter: Filter): boolean {
  if (filter !== "all" && item.kind !== filter) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.label, item.value, item.sessionTitle, item.profile ?? ""].some((v) => v.toLowerCase().includes(q));
}

export function ArtifactsRoute() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const artifactsQuery = useQuery({
    queryKey: ["artifacts"],
    queryFn: ({ signal }) => fetchRecentArtifacts(signal),
    staleTime: 30_000,
  });

  const items = useMemo(
    () => (artifactsQuery.data ?? []).filter((item) => matches(item, query, filter)),
    [artifactsQuery.data, filter, query],
  );

  const openArtifact = async (item: ArtifactRecord) => {
    if (/^https?:\/\//.test(item.value)) {
      await window.hermesDesktop?.openExternalUrl?.({ url: item.value });
    } else {
      await window.hermesDesktop?.openWorkspacePath?.({ path: item.value });
    }
  };

  return (
    <SectionShell
      title="产物库"
      sub="最近会话里的图片、文件和链接"
      right={<button className={s.btn} type="button" onClick={() => void artifactsQuery.refetch()}>刷新</button>}
    >
      <div className={s.wrap}>
        <div className={s.toolbar}>
          <div className={s.seg}>
            {(["all", "image", "file", "link"] as const).map((item) => (
              <button key={item} type="button" data-active={filter === item ? "true" : undefined} onClick={() => setFilter(item)}>
                {item === "all" ? "全部" : item === "image" ? "图片" : item === "file" ? "文件" : "链接"}
              </button>
            ))}
          </div>
          <input className={s.input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索产物、路径、来源会话" />
        </div>

        {artifactsQuery.isLoading ? (
          <div>正在索引最近会话产物...</div>
        ) : items.length === 0 ? (
          <div>没有找到产物。</div>
        ) : (
          <div className={s.grid}>
            {items.map((item) => (
              <article className={s.item} key={item.id}>
                <div className={s.preview}>
                  {item.kind === "image" && canPreviewImage(item.value) ? (
                    <img src={item.value} alt={item.label} />
                  ) : (
                    <span>{item.kind === "file" ? "FILE" : "LINK"}</span>
                  )}
                </div>
                <div className={s.title} title={item.label}>{item.label}</div>
                <div className={s.value} title={item.value}>{item.value}</div>
                <div className={s.meta}>{item.sessionTitle}{item.profile ? ` / ${item.profile}` : ""}</div>
                <div className={s.actions}>
                  <button className={s.btn} type="button" onClick={() => void navigator.clipboard.writeText(item.value)}>
                    <Copy size={14} /> 复制
                  </button>
                  <button className={s.btn} type="button" onClick={() => void openArtifact(item)}>
                    <ExternalLink size={14} /> 打开
                  </button>
                  <button className={s.btn} type="button" onClick={() => navigate(`/tasks/${encodeURIComponent(item.sessionId)}`)}>
                    <MessageSquare size={14} /> 来源
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </SectionShell>
  );
}
