// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/chat.tsx — #/wander-memory/chat: streaming chat over
// /v1/ws with REST fallback (§6.4). Ported from WanderMemory
// `web/app/src/views/ChatView.tsx` onto the Jotai transcript atoms + the
// streaming chat controller (useWanderMemoryChatStream):
//   • deltas append live into the streaming assistant bubble
//   • the done frame's reply REPLACES the bubble (authoritative)
//   • WS down → the controller falls back to REST POST /v1/chat (the badge
//     reflects the current socket state)
//   • composer disabled mid-turn; Esc cancels client-side (documented
//     limitation: server-side generation is not cancellable — the late frame
//     is discarded by the controller's per-send epoch)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Alert, Badge, Button, Input } from "@hermes/shared-ui";
import { WanderMemoryLayout } from "@/components/wander-memory/layout";
import { useWanderMemoryChatStream } from "@/hooks/use-wander-memory";
import { getWanderMemoryClient } from "@/lib/wander-memory";
import type { ConnectionState } from "@/lib/wander-memory";
import {
  clearWanderMemoryChatAtom,
  wanderMemoryChatMessagesAtom,
} from "@/stores/wander-memory-chat";
import s from "./chat.module.css";

/** Live WS connection state from the singleton client (no-op in demo mode). */
function useWanderMemoryWsState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() =>
    getWanderMemoryClient().streamingAvailable() ? "open" : "closed",
  );
  useEffect(() => {
    const client = getWanderMemoryClient();
    const unsub = client.onWsStateChange?.(setState);
    return () => {
      unsub?.();
    };
  }, []);
  return state;
}

function ChatPage() {
  const messages = useAtomValue(wanderMemoryChatMessagesAtom);
  const clearChat = useSetAtom(clearWanderMemoryChatAtom);
  const { send, cancel, isStreaming } = useWanderMemoryChatStream();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsState = useWanderMemoryWsState();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const q = input.trim();
    if (!q || isStreaming) return;
    setInput("");
    send(q);
  };

  const mode = getWanderMemoryClient().mode;
  const streamBadge =
    mode === "demo" ? (
      <Badge tone="warning" variant="outline" size="sm">
        simulated stream
      </Badge>
    ) : wsState === "open" ? (
      <Badge tone="success" variant="outline" size="sm">
        ws streaming
      </Badge>
    ) : (
      <Badge tone="warning" variant="outline" size="sm">
        stream unavailable — using REST
      </Badge>
    );

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.header}>
        <span className={s.title}>chat</span>
        {streamBadge}
        <span className={s.hint}>Esc cancels client-side · LLM · ~seconds</span>
        <span className={s.spacer} />
        <Button
          type="button"
          variant="plain"
          size="xs"
          disabled={messages.length === 0}
          onClick={() => clearChat()}
        >
          清空对话
        </Button>
      </div>

      <div ref={scrollRef} className={s.feed}>
        {messages.length === 0 ? (
          <p className={s.empty}>
            ask something — the reply is grounded on LLM-generated keywords + lexical recall
          </p>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={msg.role === "user" ? `${s.row} ${s.userRow}` : `${s.row} ${s.assistantRow}`}
            >
              <div className={msg.role === "user" ? s.userBubble : s.assistantBubble}>
                <p className={s.bubbleText}>
                  {msg.text}
                  {msg.streaming ? <span className={s.cursor} aria-hidden="true" /> : null}
                </p>

                {msg.error ? (
                  <Alert tone="danger" size="sm" className={s.msgError}>
                    {msg.error.code}: {msg.error.message}
                  </Alert>
                ) : null}

                {msg.role === "assistant" && !msg.streaming && !msg.error ? (
                  msg.dreamed && msg.dreamed.length > 0 ? (
                    <div className={s.grounding}>
                      <div className={s.keywords}>
                        keywords: {msg.dreamed.join(" · ")}
                        {msg.groundedCount !== undefined
                          ? ` → grounded on ${msg.groundedCount} memories`
                          : ""}
                      </div>
                      {msg.groundedSnippets && msg.groundedSnippets.length > 0 ? (
                        <ul className={s.snippets}>
                          {msg.groundedSnippets.map((snippet, j) => (
                            <li key={j}>· {snippet}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <div className={s.groundingPlain}>
                      grounded on plain lexical recall (keyword parse failed)
                    </div>
                  )
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className={s.composer}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape" && isStreaming) cancel();
          }}
          disabled={isStreaming}
          placeholder={
            isStreaming ? "waiting for reply… (Esc to cancel client-side)" : "type a message…"
          }
          mono
        />
        <Button
          type="button"
          variant="solid"
          tone="accent"
          onClick={submit}
          loading={isStreaming}
          disabled={isStreaming || !input.trim()}
        >
          发送
        </Button>
      </div>
      </div>
    </div>
  );
}

export function WanderMemoryChatRoute() {
  return (
    <WanderMemoryLayout title="对话" sub="MemOS · Chat">
      <ChatPage />
    </WanderMemoryLayout>
  );
}
