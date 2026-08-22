// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/status.tsx — #/wander-memory/status: server
// introspection + maintenance + endpoint discovery (§6.6). Ported from
// WanderMemory `web/app/src/views/StatusView.tsx` onto the Hermes hooks:
//   • health / models / backends cards from useWanderMemoryHealth /
//     useWanderMemoryModels / useWanderMemoryBackends (re-probed by their
//     query intervals)
//   • endpoint display from resolveEndpoints() (env → ui-store → defaults)
//   • mode badge (live/demo) from the singleton client
//   • "重新发现端点" runs resolveEndpointsAsync() (port-shift discovery, cached
//     in ui-store), rebuilds the singleton via resetWanderMemoryClient(createMemOsClient(next))
//     and invalidates every wander-memory query so they re-run against the
//     recreated client.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, LoadingState } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import {
  WANDER_MEMORY_QUERY_KEYS,
  useWanderMemoryBackends,
  useWanderMemoryHealth,
  useWanderMemoryMaintenance,
  useWanderMemoryModels,
} from "@/hooks/use-wander-memory";
import {
  createMemOsClient,
  getWanderMemoryClient,
  resetWanderMemoryClient,
  resolveEndpoints,
  resolveEndpointsAsync,
  toApiError,
} from "@/lib/wander-memory";
import type { ApiError, WanderMemoryEndpoints } from "@/lib/wander-memory";
import s from "./status.module.css";

function StatusPage() {
  const qc = useQueryClient();
  const toast = useWanderMemoryToast();

  const health = useWanderMemoryHealth();
  const models = useWanderMemoryModels();
  const backends = useWanderMemoryBackends();
  const maintenance = useWanderMemoryMaintenance();

  const [mode, setMode] = useState<"live" | "demo">(() => getWanderMemoryClient().mode);
  const [eps, setEps] = useState<WanderMemoryEndpoints>(() => resolveEndpoints());
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<ApiError | null>(null);

  const rediscover = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      // Port-shift discovery (env → ui-store → ports file/probe → defaults);
      // the discovered trio is cached in ui-store by the endpoints module.
      const next = await resolveEndpointsAsync();
      // Rebuild the singleton (disposes the old WS) so every hook re-runs
      // against the recreated client.
      resetWanderMemoryClient(createMemOsClient(next));
      setEps(next);
      setMode(getWanderMemoryClient().mode);
      qc.invalidateQueries({ queryKey: WANDER_MEMORY_QUERY_KEYS.all });
      toast.push("success", "端点已重新发现，客户端已重连");
    } catch (err) {
      setDiscoverError(toApiError(err));
    } finally {
      setDiscovering(false);
    }
  };

  const introspectError = health.error ?? models.error ?? backends.error;

  const modeBadge =
    mode === "live" ? (
      <Badge tone="success" variant="outline" size="sm">
        live
      </Badge>
    ) : (
      <Badge tone="warning" variant="outline" size="sm">
        demo
      </Badge>
    );

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.headRow}>
        <span className={s.title}>server status</span>
        {modeBadge}
        <span className={s.headHint}>health re-probes every 30 s</span>
      </div>

      {/* ── health / models / backends cards ── */}
      <div className={s.cardsGrid}>
        <section className={s.card}>
          <h3 className={s.cardTitle}>health</h3>
          {health.isLoading && !health.data ? (
            <p className={s.cardMuted}>loading…</p>
          ) : health.error ? (
            <p className={s.cardError}>{health.error.code}: {health.error.message}</p>
          ) : health.data ? (
            <dl className={s.defList}>
              <div className={s.defRow}>
                <dt className={s.defTerm}>status</dt>
                <dd className={`${s.defValue} ${s.okValue}`}>{health.data.status}</dd>
              </div>
              <div className={s.defRow}>
                <dt className={s.defTerm}>model</dt>
                <dd className={s.defValue}>{health.data.model}</dd>
              </div>
              {health.data.backend !== undefined ? (
                <div className={s.defRow}>
                  <dt className={s.defTerm}>backend</dt>
                  <dd className={s.defValue}>{health.data.backend}</dd>
                </div>
              ) : null}
              {Object.entries(health.data.backends).map(([name, ok]) => (
                <div key={name} className={s.defRow}>
                  <dt className={s.defTerm}>{name}</dt>
                  <dd className={ok ? s.okValue : s.errValue}>{ok ? "✓" : "✗"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={s.cardMuted}>unavailable</p>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.cardTitle}>models</h3>
          {models.isLoading && !models.data ? (
            <p className={s.cardMuted}>loading…</p>
          ) : models.error ? (
            <p className={s.cardError}>{models.error.code}: {models.error.message}</p>
          ) : models.data ? (
            <>
              <dl className={s.defList}>
                <div className={s.defRow}>
                  <dt className={s.defTerm}>model</dt>
                  <dd className={s.defValue}>{models.data.model}</dd>
                </div>
                <div className={s.defRow}>
                  <dt className={s.defTerm}>reasoning</dt>
                  <dd className={s.defValue}>{models.data.reasoning}</dd>
                </div>
              </dl>
              {models.data.reasoning !== "off" ? (
                <Alert tone="warning" size="sm" className={s.modelWarning}>
                  warning: reasoning is expected to be "off"
                </Alert>
              ) : null}
            </>
          ) : (
            <p className={s.cardMuted}>unavailable</p>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.cardTitle}>backends</h3>
          {backends.isLoading && !backends.data ? (
            <p className={s.cardMuted}>loading…</p>
          ) : backends.error ? (
            <p className={s.cardError}>{backends.error.code}: {backends.error.message}</p>
          ) : backends.data ? (
            backends.data.remote || backends.data.devices.length === 0 ? (
              <p className={s.cardMuted}>remote backend — no llama.cpp devices</p>
            ) : (
              <table className={s.deviceTable}>
                <thead>
                  <tr>
                    <th className={s.th}>backend</th>
                    <th className={s.th}>idx</th>
                    <th className={s.th}>name</th>
                    <th className={`${s.th} ${s.thRight}`}>MiB</th>
                  </tr>
                </thead>
                <tbody>
                  {backends.data.devices.map((d) => (
                    <tr key={`${d.backend}:${d.index}`}>
                      <td className={s.td}>{d.backend}</td>
                      <td className={s.td}>{d.index}</td>
                      <td className={s.td}>{d.name}</td>
                      <td className={`${s.td} ${s.tdRight}`}>{d.total_mib.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className={s.cardMuted}>unavailable</p>
          )}
        </section>
      </div>

      {introspectError ? (
        <Alert tone="danger" size="sm">
          introspection failed: {introspectError.code}: {introspectError.message}
        </Alert>
      ) : null}

      {/* ── maintenance ── */}
      <WanderMemorySection title="maintenance" hint="POST /v1/maintenance — re-validate the whole store">
        <div className={s.maintRow}>
          <div>
            <p className={s.maintDesc}>Re-validate every stored memory; reports total + per-item errors.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void maintenance.mutateAsync().catch((err) => toast.push("error", toApiError(err).message))}
            loading={maintenance.isPending}
            className={s.maintButton}
          >
            {maintenance.isPending ? "running…" : "run maintenance"}
          </Button>
        </div>
        {maintenance.isPending ? (
          <div className={s.maintRunning}>
            <LoadingState label="validating store…" variant="block" />
          </div>
        ) : null}
        {maintenance.data ? (
          <div className={s.maintResult}>
            total: <span className={s.maintNum}>{maintenance.data.total}</span> · errors:{" "}
            {maintenance.data.errors.length === 0 ? (
              <span className={s.okValue}>none</span>
            ) : (
              <span className={s.errValue}>{maintenance.data.errors.join("; ")}</span>
            )}
          </div>
        ) : null}
        {maintenance.error ? (
          <p className={s.maintError}>{maintenance.error.code}: {maintenance.error.message}</p>
        ) : null}
      </WanderMemorySection>

      {/* ── endpoint settings / discovery ── */}
      <WanderMemorySection
        title="endpoint settings"
        hint="env → ui-store overrides → port-shift discovery → defaults"
      >
        <dl className={s.defList}>
          <div className={s.defRow}>
            <dt className={s.defTerm}>API base URL (REST)</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.apiOrigin}</dd>
          </div>
          <div className={s.defRow}>
            <dt className={s.defTerm}>WebSocket URL</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.wsUrl}</dd>
          </div>
          <div className={s.defRow}>
            <dt className={s.defTerm}>FS origin (mem_filesys)</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.fsOrigin}</dd>
          </div>
        </dl>
        <div className={s.discoverRow}>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void rediscover()}
            loading={discovering}
          >
            {discovering ? "discovering…" : "重新发现端点"}
          </Button>
          <span className={s.discoverHint}>
            re-probes ports 18400–18409 (and the ports file) then reconnects the client
          </span>
        </div>
        {discoverError ? (
          <div className={s.discoverError}>
            <ErrorCard error={discoverError} onDismiss={() => setDiscoverError(null)} />
          </div>
        ) : null}
      </WanderMemorySection>
      </div>
    </div>
  );
}

export function WanderMemoryStatusRoute() {
  return (
    <WanderMemoryLayout title="状态" sub="MemOS · Status">
      <WanderMemoryToastProvider>
        <StatusPage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
