import type { OtelEvent, OtelSpan } from "@hermes/protocol/observability";

export class TelemetryEmitter {
  private spans: OtelSpan[] = [];
  private listeners: ((span: OtelSpan) => void)[] = [];

  subscribe(cb: (span: OtelSpan) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  startSpan(name: string, traceId?: string): SpanBuilder {
    const span: OtelSpan = {
      spanId: this.randomId(16),
      traceId,
      name,
      startTime: new Date().toISOString(),
      events: [],
    };
    return new SpanBuilder(span, (s) => this.finish(s));
  }

  private finish(span: OtelSpan): void {
    span.endTime = new Date().toISOString();
    this.spans.push(span);
    for (const cb of this.listeners) cb(span);
  }

  private randomId(len: number): string {
    return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  snapshot(): OtelSpan[] {
    return [...this.spans];
  }
}

export class SpanBuilder {
  constructor(private span: OtelSpan, private finish: (span: OtelSpan) => void) {}

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.span.events.push({ name, timestamp: new Date().toISOString(), attributes: attributes ?? {} });
    return this;
  }

  setParent(parentSpanId: string): this {
    this.span.parentSpanId = parentSpanId;
    return this;
  }

  end(): OtelSpan {
    this.finish(this.span);
    return this.span;
  }
}
