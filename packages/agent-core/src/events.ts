import type { GatewayEvent, GatewayMessageUsageT } from "@hermes/protocol";

export type AgentEvent =
  | GatewayEvent
  | AgentTurnStartEvent
  | AgentTurnCompleteEvent
  | AgentStatusEvent
  | AgentErrorEvent
  | AgentSessionCompressEvent;

export interface AgentTurnStartEvent {
  type: "agent.turn.start";
  session_id: string;
  payload: {
    turn_id: string;
    prompt: string;
  };
}

export interface AgentTurnCompleteEvent {
  type: "agent.turn.complete";
  session_id: string;
  payload: {
    turn_id: string;
    text?: string;
    usage?: GatewayMessageUsageT;
    finish_reason?: string;
  };
}

export interface AgentStatusEvent {
  type: "agent.status";
  session_id: string;
  payload: {
    kind: string;
    text: string;
  };
}

export interface AgentErrorEvent {
  type: "agent.error";
  session_id: string;
  payload: {
    message: string;
    recoverable?: boolean;
  };
}

export interface AgentSessionCompressEvent {
  type: "session.compress";
  session_id: string;
  payload: {
    status?: string;
    removed?: number;
    before_messages?: number;
    after_messages?: number;
    before_tokens?: number;
    after_tokens?: number;
    in_place?: boolean;
    old_session_id?: string;
  };
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentEventEmitter {
  emit(event: AgentEvent): void;
  on(listener: AgentEventListener): () => void;
}

export function createEventEmitter(): AgentEventEmitter {
  const listeners = new Set<AgentEventListener>();
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
