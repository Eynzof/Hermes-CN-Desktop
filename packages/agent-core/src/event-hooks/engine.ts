import type { EventHook, EventHookMatch, EventType } from "./types.js";

export class EventHookEngine {
  private hooks = new Map<string, EventHook>();

  register(hook: EventHook): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  list(): EventHook[] {
    return Array.from(this.hooks.values());
  }

  trigger(event: EventType, payload: Record<string, unknown>): EventHookMatch[] {
    const matches: EventHookMatch[] = [];
    const text = JSON.stringify(payload);
    for (const hook of this.hooks.values()) {
      if (!hook.enabled || hook.event !== event) continue;
      if (hook.pattern) {
        const re = new RegExp(hook.pattern, "i");
        if (!re.test(text)) continue;
      }
      matches.push({ hookId: hook.id, action: hook.action });
    }
    return matches;
  }
}
