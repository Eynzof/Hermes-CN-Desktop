export type EventType = "message" | "tool_call" | "turn_complete" | "session_start" | "custom";

export interface EventHook {
  id: string;
  event: EventType;
  pattern?: string;
  condition?: string;
  action: string;
  enabled: boolean;
}

export interface EventHookMatch {
  hookId: string;
  action: string;
}
