/**
 * Skills Hub panel for browsing and installing skills from a remote registry.
 *
 * Used inside the Skills route "market" tab. Keeps registry search in-process
 * via `@hermes/agent-core` SkillsHubClient and delegates disk mutations to the
 * Core `/api/skills/hub/*` RPC endpoints.
 */

import { useCallback, useMemo, useState } from "react";
import { Download, Loader2, Search, Trash2 } from "lucide-react";
import { Badge, Button, Card, Input } from "@hermes/shared-ui";
import {
  installSkill,
  uninstallSkill,
  SkillsHubClient,
  type SkillHubEntry,
} from "@/lib/skills/hub";
import s from "./skills-hub-panel.module.css";

export const DEFAULT_SKILLS_REGISTRY_URL =
  "https://hermes-agent.nousresearch.com/docs/api/skills-index.json";

export interface SkillsHubPanelProps {
  /** Registry index URL. */
  registryUrl?: string;
  /** Called after a successful install so callers can refresh local skill list. */
  onInstalled?: () => void;
  /** Called after a successful uninstall. */
  onUninstalled?: () => void;
}

function trustTone(trust: string | undefined): "success" | "warning" | "neutral" {
  if (trust === "builtin") return "success";
  if (trust === "trusted") return "success";
  return "warning";
}

export function SkillsHubPanel({
  registryUrl = DEFAULT_SKILLS_REGISTRY_URL,
  onInstalled,
  onUninstalled,
}: SkillsHubPanelProps) {
  const client = useMemo(
    () => new SkillsHubClient({ registryUrl }),
    [registryUrl],
  );

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillHubEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [uninstallingName, setUninstallingName] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  const performSearch = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLastMessage(null);
    try {
      const entries = await client.search(query.trim(), 20);
      setResults(entries);
      if (entries.length === 0) {
        setLastMessage("未找到匹配的技能。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, [client, query]);

  const handleInstall = useCallback(
    async (entry: SkillHubEntry) => {
      setInstallingId(entry.identifier);
      setError(null);
      setLastMessage(null);
      try {
        const result = await installSkill(entry.identifier, {
          registryUrl,
        });
        setLastMessage(result.message || `已安装 ${entry.name}`);
        onInstalled?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInstallingId(null);
      }
    },
    [onInstalled, registryUrl],
  );

  const handleUninstall = useCallback(
    async (name: string) => {
      setUninstallingName(name);
      setError(null);
      setLastMessage(null);
      try {
        const result = await uninstallSkill(name);
        setLastMessage(result.message || `已卸载 ${name}`);
        onUninstalled?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUninstallingName(null);
      }
    },
    [onUninstalled],
  );

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <div className={s.searchRow}>
          <Input
            className={s.searchInput}
            placeholder="搜索 Skills Hub…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void performSearch();
            }}
          />
          <Button
            type="button"
            variant="solid"
            tone="accent"
            loading={busy}
            leadingIcon={<Search size={16} />}
            onClick={() => void performSearch()}
          >
            搜索
          </Button>
        </div>
        <div className={s.hint}>
          输入关键词后按回车或点击搜索；安装来源：{registryUrl}
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}
      {lastMessage && <div className={s.message}>{lastMessage}</div>}

      <div className={s.results} role="list" aria-label="Skills Hub 搜索结果">
        {results.map((entry) => (
          <Card
            key={entry.identifier}
            variant="subtle"
            padding="sm"
            className={s.resultCard}
            title={
              <div className={s.resultTitleRow}>
                <span className={s.resultName}>{entry.name}</span>
                <Badge tone={trustTone(entry.trust_level)} variant="soft" size="sm">
                  {entry.trust_level || "community"}
                </Badge>
              </div>
            }
            footer={
              <div className={s.resultFooter}>
                <span className={s.resultMeta}>{entry.identifier}</span>
                <div className={s.resultActions}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    tone="danger"
                    loading={uninstallingName === entry.name}
                    leadingIcon={<Trash2 size={12} />}
                    onClick={() => void handleUninstall(entry.name)}
                  >
                    卸载
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="solid"
                    tone="accent"
                    loading={installingId === entry.identifier}
                    leadingIcon={<Download size={12} />}
                    onClick={() => void handleInstall(entry)}
                  >
                    安装
                  </Button>
                </div>
              </div>
            }
          >
            <p className={s.resultDescription}>{entry.description || "无描述"}</p>
            {entry.tags && entry.tags.length > 0 && (
              <div className={s.tags}>
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant="outline" size="sm">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        ))}
        {busy && results.length === 0 && (
          <div className={s.empty}>
            <Loader2 size={16} className={s.spin} />
            正在搜索…
          </div>
        )}
        {!busy && results.length === 0 && !error && !lastMessage && (
          <div className={s.empty}>输入关键词开始搜索 Skills Hub。</div>
        )}
      </div>
    </div>
  );
}
