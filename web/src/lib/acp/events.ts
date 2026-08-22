export interface AcpEvent {
  type: "message" | "thinking" | "tool" | "plan";
  payload: unknown;
}

export class AcpEventBridge {
  private listeners: Array<(event: AcpEvent) => void> = [];

  subscribe(cb: (event: AcpEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: AcpEvent): void {
    for (const cb of this.listeners) cb(event);
  }
}
