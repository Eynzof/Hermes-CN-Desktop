import type { GatewayEvent } from "@hermes/protocol";

/**
 * Coalesce streaming `message.delta` events into one apply per animation frame.
 *
 * Each gateway `message.delta` triggers a Jotai write and a full re-parse of the
 * growing assistant markdown (`<Streamdown>` + KaTeX/mermaid/rehype). At token
 * speed that re-renders dozens of times a second, which is what makes long
 * answers feel choppy in the desktop app compared to the CLI (which just
 * line-buffers prints). Buffering the pure-text deltas that arrive within a
 * single frame and applying their concatenation once collapses N re-renders per
 * frame down to one, with no change to the reducer.
 *
 * Ordering guarantees:
 *  - Only plain-text deltas (a string `payload.text`, no image fields) are
 *    buffered. Any other event — including a delta that also carries images —
 *    first flushes the buffered text, then applies as-is, so nothing is
 *    reordered or dropped.
 *  - `message.complete` / `message.start` / `error` are non-delta events, so the
 *    final tokens of a turn are always flushed before the turn closes.
 */
type ApplyFn = (event: GatewayEvent) => void;

interface CoalescerOptions {
  /** Frame scheduler; injectable for tests / non-browser environments. */
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface DeltaCoalescer {
  dispatch: (event: GatewayEvent) => void;
  /** Apply any buffered deltas immediately (call on disconnect / teardown). */
  flush: () => void;
}

function isCoalescablePureTextDelta(event: GatewayEvent): boolean {
  if (event.type !== "message.delta" || !event.session_id) return false;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.text !== "string") return false;
  // A delta that also carries an image must keep its exact position relative to
  // surrounding text — never merge those.
  if ("images" in payload || "image" in payload || "image_url" in payload) {
    return false;
  }
  return true;
}

export function createDeltaCoalescer(
  apply: ApplyFn,
  options: CoalescerOptions = {},
): DeltaCoalescer {
  const requestFrame =
    options.requestFrame ??
    (typeof requestAnimationFrame === "function"
      ? (cb: () => void) => requestAnimationFrame(cb)
      : null);
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === "function"
      ? (handle: number) => cancelAnimationFrame(handle)
      : undefined);

  // session_id -> running text concat + the latest delta event used as a shape
  // template (its own `text` is overwritten with the concatenation on flush).
  const pending = new Map<string, { text: string; template: GatewayEvent }>();
  let frameHandle: number | null = null;

  function flush(): void {
    if (frameHandle !== null) {
      cancelFrame?.(frameHandle);
      frameHandle = null;
    }
    if (pending.size === 0) return;
    const buffered = Array.from(pending.values());
    pending.clear();
    for (const { text, template } of buffered) {
      const basePayload =
        template.payload && typeof template.payload === "object"
          ? (template.payload as Record<string, unknown>)
          : {};
      apply({ ...template, payload: { ...basePayload, text } } as GatewayEvent);
    }
  }

  function dispatch(event: GatewayEvent): void {
    // Without a frame scheduler (SSR / tests) never buffer — apply immediately.
    if (requestFrame && isCoalescablePureTextDelta(event)) {
      const sessionId = event.session_id as string;
      const chunk = (event.payload as Record<string, unknown>).text as string;
      const prev = pending.get(sessionId);
      pending.set(sessionId, { text: (prev?.text ?? "") + chunk, template: event });
      if (frameHandle === null) {
        frameHandle = requestFrame(() => {
          frameHandle = null;
          flush();
        });
      }
      return;
    }
    // Any non-buffered event: preserve ordering by applying buffered text first.
    flush();
    apply(event);
  }

  return { dispatch, flush };
}
