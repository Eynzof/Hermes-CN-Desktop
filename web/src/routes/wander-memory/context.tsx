// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/context.tsx — #/wander-memory/context: prompt-injection
// block preview (§6.5). Ported from WanderMemory
// `web/app/src/views/ContextView.tsx` onto useWanderMemoryContext.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Button, CopyButton, EmptyState, Input, LoadingState } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import { useWanderMemoryContext } from "@/hooks/use-wander-memory";
import { toApiError } from "@/lib/wander-memory";
import type { ApiError } from "@/lib/wander-memory";
import s from "./context.module.css";

function ContextPage() {
  const build = useWanderMemoryContext();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("");
  const [context, setContext] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<ApiError | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setBuildError(null);
    try {
      const k = topK.trim() ? Number(topK) : undefined;
      const res = await build.mutateAsync({ query: q, topK: k });
      setContext(res.context);
    } catch (err) {
      setBuildError(toApiError(err));
    }
  };

  return (
    <WanderMemorySection
      title="context preview"
      hint="POST /v1/context — exactly the date-prefixed block that would be injected into a prompt"
    >
      <div className={s.buildRow}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          placeholder="query…"
          mono
          className={s.queryInput}
        />
        <Input
          value={topK}
          onChange={(e) => setTopK(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="top_k"
          title="top_k — leave empty to use the server default"
          mono
          className={s.topK}
        />
        <Button
          type="button"
          variant="outline"
          tone="accent"
          onClick={() => void run()}
          loading={build.isPending}
          disabled={!query.trim()}
        >
          build
        </Button>
      </div>

      <div className={s.output}>
        {buildError ? (
          <ErrorCard
            error={buildError}
            onDismiss={() => setBuildError(null)}
            retry={() => void run()}
          />
        ) : build.isPending ? (
          <LoadingState label="building context…" variant="block" />
        ) : context === null ? null : context === "" ? (
          <EmptyState title="no memories matched — the API returned an empty string" />
        ) : (
          <div className={s.contextBlock}>
            <div className={s.contextHead}>
              <span className={s.contextLabel}>context</span>
              <CopyButton text={context} variant="outline" size="xs" copiedLabel="已复制">
                copy
              </CopyButton>
            </div>
            <pre className={s.contextText}>{context}</pre>
          </div>
        )}
      </div>
    </WanderMemorySection>
  );
}

export function WanderMemoryContextRoute() {
  return (
    <WanderMemoryLayout title="上下文预览" sub="MemOS · Context">
      <ContextPage />
    </WanderMemoryLayout>
  );
}
