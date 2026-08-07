// ─────────────────────────────────────────────────────────────────────────────
// components/wander-memory/memory-card.tsx — a single memory entry card,
// ported from WanderMemory `web/app/src/components/shared.tsx` (MemoryCard)
// onto Hermes CSS Modules + design tokens + shared-ui primitives.
//
// Zero-trust rendering: the memory text is rendered through a React text node
// (textContent semantics) — never dangerouslySetInnerHTML.
// ─────────────────────────────────────────────────────────────────────────────

import { Badge, Button, CopyButton } from "@hermes/shared-ui";
import type { CollisionSummary, MemoryItem } from "@/lib/wander-memory";
import { CollisionLine } from "./collision-line";
import s from "./memory-card.module.css";

export interface MemoryCardProps {
  item: MemoryItem;
  /** Called with the item id when the delete action is confirmed by the route. */
  onDelete?: (id: string) => void;
  /** Called with the item id when the user asks to inspect the raw JSON. */
  onView?: (id: string) => void;
  /** Collision summary from the write that produced this item, if any. */
  collision?: CollisionSummary;
  /** Disables the delete button while a delete is in flight. */
  deleting?: boolean;
}

/** §3.1 metadata may carry `updated_at`; surface it as a line instead of a chip. */
function formatUpdatedAt(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds epoch (memory APIs) vs milliseconds epoch — pick by magnitude.
    const ms = value > 1e12 ? value : value * 1000;
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(value);
    }
  }
  return null;
}

function displayMetaValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function MemoryCard({ item, onDelete, onView, collision, deleting = false }: MemoryCardProps) {
  const short = item.id.slice(0, 8);
  const updatedAt = formatUpdatedAt(item.metadata.updated_at);

  return (
    <article className={s.card} data-pending={deleting ? "true" : undefined}>
      <p className={s.memory}>{item.memory}</p>

      <div className={s.metaRow}>
        <CopyButton
          text={item.id}
          variant="outline"
          size="xs"
          className={s.idChip}
          copiedLabel="已复制"
          title={`${item.id} — 点击复制`}
        >
          {short}…
        </CopyButton>
        {Object.entries(item.metadata)
          .filter(([key]) => key !== "updated_at")
          .map(([key, value]) => (
            <Badge key={key} tone="neutral" variant="soft" size="sm" className={s.chip}>
              {key}={displayMetaValue(value)}
            </Badge>
          ))}
        <span className={s.spacer} />
        {onView ? (
          <Button
            type="button"
            variant="plain"
            size="xs"
            aria-label={`查看记忆 ${short}`}
            onClick={() => onView(item.id)}
          >
            查看 JSON
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            type="button"
            variant="plain"
            tone="danger"
            size="xs"
            aria-label={`删除记忆 ${short}`}
            disabled={deleting}
            loading={deleting}
            onClick={() => onDelete(item.id)}
          >
            删除
          </Button>
        ) : null}
      </div>

      {updatedAt ? <div className={s.updatedAt}>更新于 {updatedAt}</div> : null}

      {collision ? (
        <div className={s.collision}>
          <CollisionLine collision={collision} />
        </div>
      ) : null}
    </article>
  );
}
