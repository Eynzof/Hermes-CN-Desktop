// ─────────────────────────────────────────────────────────────────────────────
// components/wander-memory/collision-line.tsx — collision summary rendering,
// ported from WanderMemory `web/app/src/components/shared.tsx` (CollisionLine)
// onto Hermes tokens. Extends the CLI-style one-liner with an optional
// snippet list and accept/ignore actions for interactive write flows
// (e.g. dialogue import), so the same component serves read-only cards and
// decision points.
// ─────────────────────────────────────────────────────────────────────────────

import { Button } from "@hermes/shared-ui";
import type { CollisionSummary } from "@/lib/wander-memory";
import s from "./collision-line.module.css";

export interface CollisionLineProps {
  /** §4.1 collision summary — ALWAYS present on write responses. */
  collision: CollisionSummary;
  /** Optional existing-memory snippets surfaced by the route (e.g. dialogue import). */
  snippets?: string[];
  /** Confirm the collision — the route decides what "accept" means. */
  onAccept?: () => void;
  /** Dismiss the collision without accepting. */
  onIgnore?: () => void;
  /** Disables the action buttons while an operation is pending. */
  pending?: boolean;
}

export function CollisionLine({
  collision,
  snippets,
  onAccept,
  onIgnore,
  pending = false,
}: CollisionLineProps) {
  const clean = collision.stored_new && collision.deleted === 0 && collision.merged === 0;

  if (clean) {
    return (
      <p className={s.clean} role="status">
        collision: none — 已直接存储
      </p>
    );
  }

  const affected = collision.merged + collision.deleted;
  const detail = `合并 ${collision.merged} 条，删除 ${collision.deleted} 条${
    collision.reason ? `（${collision.reason}）` : ""
  }`;

  return (
    <div className={s.line} data-variant="conflict">
      <div className={s.head}>
        <strong className={s.title}>与 {affected} 条既有记忆冲突</strong>
        {!collision.stored_new ? <span className={s.notStored}>未存储</span> : null}
      </div>
      <p className={s.detail}>{detail}</p>

      {snippets && snippets.length > 0 ? (
        <ul className={s.snippets}>
          {snippets.map((snippet, index) => (
            <li key={index}>{snippet}</li>
          ))}
        </ul>
      ) : null}

      {onAccept || onIgnore ? (
        <div className={s.actions}>
          {onAccept ? (
            <Button type="button" variant="soft" tone="accent" size="xs" loading={pending} onClick={onAccept}>
              接受冲突
            </Button>
          ) : null}
          {onIgnore ? (
            <Button type="button" variant="outline" size="xs" disabled={pending} onClick={onIgnore}>
              忽略
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
