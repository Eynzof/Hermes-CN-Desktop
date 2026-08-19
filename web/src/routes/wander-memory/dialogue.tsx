// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/dialogue.tsx — #/wander-memory/dialogue: transcript
// import (§6.3). Ported from WanderMemory `web/app/src/views/DialogueView.tsx`.
// Longest latency path in the app (1 + N LLM calls): no client timeout, explicit
// copy, button disabled while the health probe reports no local LLM backend.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Button, EmptyState, LoadingState, Textarea } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import { MemoryCard } from "@/components/wander-memory/memory-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import {
  useWanderMemoryDialogue,
  useWanderMemoryHealth,
} from "@/hooks/use-wander-memory";
import {
  COLLISION_ERROR_CODES,
  toApiError,
} from "@/lib/wander-memory";
import type { ApiError, AddDialogueResponse } from "@/lib/wander-memory";
import s from "./dialogue.module.css";

/** True when the health probe reports no reachable local LLM backend. */
function useWanderMemoryDegraded(): boolean {
  const health = useWanderMemoryHealth({ refetchInterval: 30_000 });
  return (
    health.isError ||
    (health.data !== undefined &&
      Object.keys(health.data.backends).length === 0 &&
      health.data.backend === undefined)
  );
}

function DialoguePage() {
  const toast = useWanderMemoryToast();
  const dialogue = useWanderMemoryDialogue();
  const degraded = useWanderMemoryDegraded();

  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AddDialogueResponse | null>(null);
  const [failError, setFailError] = useState<ApiError | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const looksLikeJson = (() => {
    const t = text.trim();
    if (!t.startsWith("[")) return false;
    try {
      const v = JSON.parse(t) as unknown;
      return (
        Array.isArray(v) &&
        v.every((m) => m && typeof m === "object" && "role" in m && "content" in m)
      );
    } catch {
      return false;
    }
  })();

  const submit = async () => {
    setInlineError(null);
    setFailError(null);
    setResult(null);
    if (!text.trim()) {
      setInlineError("field 'dialogue' must be a non-empty string");
      return;
    }
    setRunning(true);
    try {
      // Sent verbatim (may be a transcript string or a JSON message array).
      const res = await dialogue.mutateAsync({ dialogue: text });
      setResult(res);
      toast.push("success", `imported ${res.stored.length} memories — inventory total: ${res.total}`);
    } catch (err) {
      const apiErr = toApiError(err);
      if ((COLLISION_ERROR_CODES as readonly string[]).includes(apiErr.code)) {
        setFailError(apiErr);
      } else if (apiErr.code === "bad_request") {
        setInlineError(apiErr.message);
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={s.dialogueGrid}>
      {/* ── left: dialogue import ── */}
      <WanderMemorySection
        title="dialogue import"
        hint="extraction + N collision LLM calls · the longest path in the app · no client timeout"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder={
            "paste a transcript (one utterance per line)…\n\nuser: 我对花生过敏\nassistant: 已记下\n\n…or a JSON array of {\"role\",\"content\"} messages — it is sent verbatim."
          }
          mono
          className={s.dialogueTextarea}
        />
        {looksLikeJson ? (
          <p className={s.jsonHint}>✓ detected a JSON message array — will be sent verbatim</p>
        ) : null}
        {inlineError ? <p className={s.inlineError}>{inlineError}</p> : null}

        <div className={s.importActions}>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void submit()}
            loading={running}
            disabled={running || degraded}
          >
            {running ? "extracting + colliding…" : "import dialogue"}
          </Button>
          {degraded ? <span className={s.degradedHint}>disabled — LLM unavailable</span> : null}
        </div>

        {running ? (
          <div className={s.runningBox}>
            <LoadingState
              label="running extraction and collision pipeline — this can take a while (1 + N LLM calls)"
              variant="block"
            />
          </div>
        ) : null}
        {failError ? (
          <div className={s.runningBox}>
            <ErrorCard error={failError} onDismiss={() => setFailError(null)} />
          </div>
        ) : null}

        <p className={s.footnote}>
          fail-closed: on any collision_* error, nothing from this dialogue was stored.
        </p>
      </WanderMemorySection>

      {/* ── right: results ── */}
      <WanderMemorySection title="import results">
        {result ? (
          <>
            <h3 className={s.resultSummary}>
              stored <span className={s.resultNum}>{result.stored.length}</span> · total{" "}
              <span className={s.resultNum}>{result.total}</span>
            </h3>
            <div className={s.resultsList}>
              {result.stored.map((item, i) => (
                <MemoryCard key={item.id} item={item} collision={result.collisions[i]} />
              ))}
            </div>
          </>
        ) : !running ? (
          <EmptyState
            title="import results appear here"
            description="each stored memory with its index-aligned collision summary"
          />
        ) : null}
      </WanderMemorySection>
    </div>
  );
}

export function WanderMemoryDialogueRoute() {
  return (
    <WanderMemoryLayout title="对话导入" sub="MemOS · Dialogue">
      <WanderMemoryToastProvider>
        <DialoguePage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
