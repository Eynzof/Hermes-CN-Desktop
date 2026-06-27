import type { ReactNode } from "react";
import { Badge, Button } from "@hermes/shared-ui";
import type { McpCatalogEntry } from "@hermes/protocol";
import { openExternalUrl } from "@/lib/external-links";
import { isHttpUrl, transportTone } from "./parse";
import s from "./mcp.module.css";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={s.link}
      onClick={(e) => {
        e.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function McpCatalogCard({
  entry,
  diagnostics,
  installing,
  onInstall,
}: {
  entry: McpCatalogEntry;
  diagnostics: string[];
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className={s.card}>
      <div className={s.cardMain}>
        <div className={s.cardHead}>
          <span className={s.cardName}>{entry.name}</span>
          <Badge tone={transportTone(entry.transport)} variant="soft" size="sm">
            {entry.transport}
          </Badge>
          <Badge tone="neutral" variant="outline" size="sm">
            认证：{entry.auth_type}
          </Badge>
          {entry.source &&
            (isHttpUrl(entry.source) ? (
              <ExternalLink href={entry.source}>来源 ↗</ExternalLink>
            ) : (
              <Badge tone="neutral" variant="outline" size="sm">
                {entry.source}
              </Badge>
            ))}
          {entry.installed && (
            <Badge tone="success" variant="soft" size="sm">
              已安装
            </Badge>
          )}
          {entry.installed && !entry.enabled && (
            <Badge tone="neutral" variant="outline" size="sm">
              已禁用
            </Badge>
          )}
        </div>

        {entry.description && <p className={s.cardDesc}>{entry.description}</p>}

        {entry.transport === "http" && entry.url && (
          <p className={s.detail}>
            <span className={s.detailLabel}>端点：</span>
            <code>{entry.url}</code>
          </p>
        )}
        {entry.transport === "stdio" && entry.command && (
          <p className={s.detail}>
            <span className={s.detailLabel}>运行：</span>
            <code>{[entry.command, ...entry.args].join(" ")}</code>
          </p>
        )}

        {entry.install_url && (
          <p className={s.detail}>
            <span className={s.detailLabel}>安装自：</span>{" "}
            {isHttpUrl(entry.install_url) ? (
              <ExternalLink href={entry.install_url}>{entry.install_url}</ExternalLink>
            ) : (
              <code>{entry.install_url}</code>
            )}
            {entry.install_ref && <span> @ {entry.install_ref}</span>}
          </p>
        )}

        {entry.bootstrap.length > 0 && (
          <details className={s.details}>
            <summary>初始化命令（{entry.bootstrap.length}）</summary>
            <div className={s.detailsList}>
              {entry.bootstrap.map((cmd, i) => (
                <code key={`${entry.name}-bs-${i}`}>{cmd}</code>
              ))}
            </div>
          </details>
        )}

        {entry.post_install && (
          <details className={s.details}>
            <summary>安装说明</summary>
            <p className={s.postInstall}>{entry.post_install.trim()}</p>
          </details>
        )}

        {diagnostics.map((msg, i) => (
          <p key={`${entry.name}-diag-${i}`} className={s.diag}>
            {msg}
          </p>
        ))}
      </div>

      <div className={s.cardActions}>
        {entry.installed ? (
          <Badge tone="success" variant="soft" size="sm">
            已安装
          </Badge>
        ) : (
          <Button
            variant="solid"
            tone="accent"
            size="sm"
            loading={installing}
            onClick={onInstall}
          >
            {installing ? "安装中…" : "安装"}
          </Button>
        )}
      </div>
    </div>
  );
}
