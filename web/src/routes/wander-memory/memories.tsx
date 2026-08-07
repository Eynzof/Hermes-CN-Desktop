// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/memories.tsx — #/wander-memory/memories: inventory +
// search + add + delete (§6.2). Ported from WanderMemory
// `web/app/src/views/MemoriesView.tsx` onto Hermes hooks + shared-ui.
//
// The request-epoch staleness guard (§6.2) is ported verbatim: every read
// captures the current epoch; a write (add/delete) bumps it once it succeeds,
// so a list/search snapshot taken BEFORE the write can never land AFTER it and
// resurrect deleted memories (or clobber a just-added one) in the UI. Writes go
// through the TanStack mutation hooks (useWanderMemoryAdd / useWanderMemoryDelete)
// which additionally invalidate the list/search query cache server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, EmptyState, Input, LoadingState, Textarea } from "@hermes/shared-ui";
import { CollisionLine } from "@/components/wander-memory/collision-line";
import { ErrorCard } from "@/components/wander-memory/error-card";
import { MemoryCard } from "@/components/wander-memory/memory-card";
import {
  PageGrid,
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import { useWanderMemoryAdd, useWanderMemoryDelete } from "@/hooks/use-wander-memory";
import {
  ApiError,
  COLLISION_ERROR_CODES,
  getWanderMemoryClient,
  toApiError,
} from "@/lib/wander-memory";
import type { CollisionSummary, MemoryItem } from "@/lib/wander-memory";
import s from "./memories.module.css";

/** CLI-style metadata editor convention: key=value lines (§6.2). */
function parseMetadata(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function MemoriesPage() {
  const toast = useWanderMemoryToast();
  const add = useWanderMemoryAdd();
  const del = useWanderMemoryDelete();

  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("");
  const [results, setResults] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const [newText, setNewText] = useState("");
  const [newMeta, setNewMeta] = useState("");
  const [addCollision, setAddCollision] = useState<CollisionSummary | null>(null);
  const [addError, setAddError] = useState<ApiError | null>(null);

  const [viewId, setViewId] = useState<string | null>(null);
  const [viewData, setViewData] = useState<unknown>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Staleness guard for async list/search responses. Every read captures the
  // current epoch; a write (add/delete) bumps it once it succeeds, so a
  // list/search snapshot taken BEFORE the write can never land AFTER it and
  // resurrect deleted memories (or clobber a just-added one) in the UI.
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await getWanderMemoryClient().list();
      if (seq !== reqSeq.current) return; // superseded by a newer request/write
      setResults(res.results);
      setListError(null);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const apiErr = toApiError(err);
      // network_failure is handled centrally (demo fall-over) — no noisy toast.
      if (apiErr.code !== "network_failure") setListError(apiErr);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) {
      setSearching(true);
      await refresh();
      setSearching(false);
      return;
    }
    setSearching(true);
    setListError(null);
    setInlineError(null);
    const seq = ++reqSeq.current;
    try {
      const k = topK.trim() ? Number(topK) : undefined;
      const res = await getWanderMemoryClient().search(q, k);
      if (seq !== reqSeq.current) return; // superseded by a newer request/write
      setResults(res.results);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const apiErr = toApiError(err);
      if (apiErr.code === "bad_request") setInlineError(apiErr.message);
      else toast.push("error", `${apiErr.code}: ${apiErr.message}`);
    } finally {
      if (seq === reqSeq.current) setSearching(false);
    }
  };

  const doAdd = async () => {
    setInlineError(null);
    setAddError(null);
    setAddCollision(null);
    if (!newText.trim()) {
      setInlineError("field 'memory' must be a non-empty string");
      return;
    }
    const meta = newMeta.trim() ? parseMetadata(newMeta) : {};
    if (meta === null) {
      setInlineError("metadata must be key=value lines (e.g. type=fact)");
      return;
    }
    try {
      const res = await add.mutateAsync({
        text: newText.trim(),
        metadata: Object.keys(meta).length ? meta : undefined,
      });
      setAddCollision(res.collision);
      setNewText("");
      setNewMeta("");
      // The write changed server state — invalidate any in-flight list/search
      // snapshot taken before it, then reconcile in the background (§6.2).
      reqSeq.current += 1;
      if (res.collision.stored_new) setResults((r) => [res.memory, ...r]);
      void refresh();
    } catch (err) {
      const apiErr = toApiError(err);
      if ((COLLISION_ERROR_CODES as readonly string[]).includes(apiErr.code)) {
        setAddError(apiErr);
      } else if (apiErr.code === "bad_request") {
        setInlineError(apiErr.message);
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    }
  };

  const doView = async (id: string) => {
    try {
      const res = await getWanderMemoryClient().get(id);
      setViewData(res);
      setViewId(id);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.code === "not_found") {
        toast.push("error", "memory not found — the list may be stale");
        void refresh();
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    }
  };

  const doDelete = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    setDeletingId(id);
    try {
      await del.mutateAsync({ id });
      // The DELETE succeeded — invalidate any in-flight list/search snapshot
      // taken before it, so the deleted memory can never be resurrected in the
      // UI by a stale response landing after this point.
      reqSeq.current += 1;
      setResults((r) => r.filter((m) => m.id !== id));
      toast.push("success", `已删除 ${id.slice(0, 8)}…`);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.code === "not_found") {
        toast.push("error", "memory not found — the list may be stale");
        void refresh();
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
        // The server may still have applied the DELETE (e.g. a timed-out
        // response) — re-sync instead of trusting the stale local list.
        void refresh();
      }
    } finally {
      setDeletingId(null);
    }
  };

  const busy = loading || searching;

  return (
    <PageGrid>
      {/* ── left: search + results ── */}
      <WanderMemorySection title="检索与库存" hint="empty query lists the full inventory">
        <div className={s.searchRow}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
            placeholder="search memories… (empty query lists the full inventory)"
            mono
            className={s.searchInput}
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
            onClick={() => void doSearch()}
            loading={searching}
          >
            {searching ? "…" : "搜索"}
          </Button>
        </div>
        {inlineError ? <p className={s.inlineError}>{inlineError}</p> : null}

        <div className={s.results}>
          {listError ? (
            <ErrorCard
              error={listError}
              onDismiss={() => setListError(null)}
              retry={() => void refresh()}
            />
          ) : busy ? (
            <LoadingState label="loading inventory…" variant="block" />
          ) : results.length === 0 ? (
            <EmptyState
              title="no memories matched"
              description="search again with a different query, or add a memory on the right."
            />
          ) : (
            results.map((m) => (
              <MemoryCard
                key={m.id}
                item={m}
                onView={(id) => void doView(id)}
                onDelete={setDeleteId}
                deleting={deletingId === m.id}
              />
            ))
          )}
        </div>
      </WanderMemorySection>

      {/* ── right: add memory ── */}
      <WanderMemorySection title="添加记忆" hint="0–1 LLM calls · ~seconds">
        <div className={s.addPanel}>
          <Textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={4}
            placeholder="memory text…"
            className={s.addTextarea}
          />
          <Textarea
            value={newMeta}
            onChange={(e) => setNewMeta(e.target.value)}
            rows={2}
            placeholder={"metadata (optional, key=value per line)\ntype=fact"}
            mono
            className={s.addTextarea}
          />
          <Button
            type="button"
            variant="outline"
            tone="accent"
            fullWidth
            onClick={() => void doAdd()}
            loading={add.isPending}
            disabled={add.isPending}
            className={s.addButton}
          >
            {add.isPending ? "storing…" : "store memory"}
          </Button>

          <div className={s.addFeedback}>
            {addError ? (
              <ErrorCard error={addError} onDismiss={() => setAddError(null)} />
            ) : addCollision ? (
              <div className={s.collisionBox}>
                <CollisionLine collision={addCollision} />
              </div>
            ) : null}
          </div>

          <p className={s.footnote}>
            fail-closed: on collision_parse_failed / collision_validation_failed / collision_apply_failed
            the memory was NOT stored. There is no update endpoint — the write path is add + collision merge only.
          </p>
        </div>
      </WanderMemorySection>

      {/* ── view JSON ── */}
      <Dialog.Root
        open={viewId !== null && viewData !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewId(null);
            setViewData(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dialogContent}>
            <Dialog.Title className={s.dialogTitle}>
              GET /v1/memories/{viewId?.slice(0, 8)}…
            </Dialog.Title>
            <pre className={s.jsonBlock}>{JSON.stringify(viewData, null, 2)}</pre>
            <div className={s.dialogActions}>
              <Dialog.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  关闭
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── delete confirm ── */}
      <Dialog.Root
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dialogContent}>
            <Dialog.Title>删除记忆</Dialog.Title>
            <Dialog.Description className={s.dialogDesc}>
              Delete memory {deleteId?.slice(0, 8)}…? This calls DELETE /v1/memories/{`{id}`} and cannot be
              undone.
            </Dialog.Description>
            <div className={s.dialogActions}>
              <Button type="button" variant="outline" onClick={() => setDeleteId(null)} disabled={deletingId !== null}>
                取消
              </Button>
              <Button
                type="button"
                variant="solid"
                tone="danger"
                onClick={() => void doDelete()}
                loading={deletingId !== null}
                disabled={deletingId !== null}
              >
                删除
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PageGrid>
  );
}

export function WanderMemoryMemoriesRoute() {
  return (
    <WanderMemoryLayout title="记忆" sub="MemOS · Memories">
      <WanderMemoryToastProvider>
        <MemoriesPage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
