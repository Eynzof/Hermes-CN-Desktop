import type { CodexItemEvent } from "./types.js";

export type CodexEventListener = (event: { type: string; payload: unknown }) => void;

export class CodexEventBridge {
  private listeners: CodexEventListener[] = [];

  subscribe(cb: CodexEventListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: CodexItemEvent): void {
    const mapped = this.map(event);
    if (mapped) {
      for (const cb of this.listeners) cb(mapped);
    }
  }

  private map(event: CodexItemEvent): { type: string; payload: unknown } | null {
    if (event.type.startsWith("item/")) {
      return { type: "codex.item", payload: event };
    }
    return { type: "codex.raw", payload: event };
  }
}
