import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalResult,
} from "./types.js";
import { CompositePolicy } from "./policy.js";

/**
 * Lifecycle events emitted by `ApprovalGate`.
 *
 * `approval.requested` is emitted when a request must be shown to the user.
 * `approval.resolved` is emitted whenever a request reaches a final state.
 * `approval.pending_changed` mirrors the current pending list for UI sync.
 */
export interface ApprovalRequestedEvent {
  type: "approval.requested";
  session_id: string;
  payload: {
    request: ApprovalRequest;
  };
}

export interface ApprovalResolvedEvent {
  type: "approval.resolved";
  session_id: string;
  payload: {
    request: ApprovalRequest;
    result: ApprovalResult;
  };
}

export interface ApprovalPendingChangedEvent {
  type: "approval.pending_changed";
  session_id: string;
  payload: {
    pending: ApprovalRequest[];
  };
}

export type ApprovalEvent =
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalPendingChangedEvent;

export type ApprovalEventListener = (event: ApprovalEvent) => void;

export interface ApprovalEventEmitter {
  emit(event: ApprovalEvent): void;
  on(listener: ApprovalEventListener): () => void;
}

export function createApprovalEventEmitter(): ApprovalEventEmitter {
  const listeners = new Set<ApprovalEventListener>();
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

/** Resolution promise stored while a request is waiting for user input. */
interface PendingEntry {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface ApprovalGateOptions {
  policy: ApprovalPolicy;
  emitter?: ApprovalEventEmitter;
  /**
   * Fail-closed timeout in milliseconds. Silence is not consent: if the user
   * does not respond before the timeout, the request is denied.
   */
  timeoutMs?: number;
  /**
   * Stable id factory. Defaults to `crypto.randomUUID` when available.
   */
  generateId?: () => string;
}

/**
 * Single authority for tool-call approvals.
 *
 * - Policies produce an immediate `approve` / `deny` / `ask` verdict.
 * - `ask` requests are held as pending until `resolve` is called or the
   timeout fires.
 * - Resolved requests emit `approval.resolved`; pending lists emit
   `approval.pending_changed`.
 */
export class ApprovalGate {
  private readonly policy: ApprovalPolicy;
  private readonly emitter: ApprovalEventEmitter;
  private readonly timeoutMs: number;
  private readonly generateId: () => string;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(options: ApprovalGateOptions) {
    this.policy = options.policy;
    this.emitter = options.emitter ?? createApprovalEventEmitter();
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.generateId =
      options.generateId ??
      (() => {
        if (typeof globalThis.crypto?.randomUUID === "function") {
          return globalThis.crypto.randomUUID();
        }
        return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      });
  }

  on(listener: ApprovalEventListener): () => void {
    return this.emitter.on(listener);
  }

  /**
   * Evaluate a request through the policy chain.
   *
   * Returns a promise that resolves immediately for `approve`/`deny` decisions
   * and waits for user interaction when `ask` is returned.
   */
  async request(
    partial: Omit<ApprovalRequest, "id">,
  ): Promise<ApprovalResult> {
    const request: ApprovalRequest = { ...partial, id: this.generateId() };
    const result = this.policy.evaluate(request);

    if (result) {
      if (result.decision !== "ask") {
        return this.finalize(request, {
          requestId: request.id,
          decision: result.decision,
        });
      }
    } else {
      // No policy returned a verdict: the operation is not dangerous and the
      // tool did not opt into explicit gating, so approve by default.
      return this.finalize(request, {
        requestId: request.id,
        decision: "approve",
      });
    }

    return this.holdForUser(request);
  }

  /** Pending requests awaiting user review. */
  listPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  /** Pending requests for a specific session. */
  listPendingForSession(sessionId: string): ApprovalRequest[] {
    return this.listPending().filter((r) => r.sessionId === sessionId);
  }

  /** Resolve a pending request by id. */
  resolve(id: string, response: Omit<ApprovalResponse, "requestId">): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.clearEntry(entry);
    const result: ApprovalResult = {
      requestId: id,
      decision: response.decision,
      response: { ...response, requestId: id },
    };
    entry.resolve(this.finalize(entry.request, result, false));
    return true;
  }

  /** Cancel and deny all pending requests for a session. */
  cancelSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) {
        this.clearEntry(entry);
        const result: ApprovalResult = {
          requestId: id,
          decision: "deny",
        };
        entry.resolve(this.finalize(entry.request, result, false));
      }
    }
  }

  private holdForUser(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve, reject) => {
      const entry: PendingEntry = {
        request,
        resolve,
        reject,
        timeout:
          this.timeoutMs > 0
            ? setTimeout(() => {
                this.clearEntry(entry);
                resolve(
                  this.finalize(
                    request,
                    { requestId: request.id, decision: "deny" },
                    false,
                  ),
                );
              }, this.timeoutMs)
            : undefined,
      };
      this.pending.set(request.id, entry);
      this.emitPendingChanged(request.sessionId);
      this.emitter.emit({
        type: "approval.requested",
        session_id: request.sessionId,
        payload: { request },
      });
    });
  }

  private finalize(
    request: ApprovalRequest,
    result: ApprovalResult,
    removeFromPending = true,
  ): ApprovalResult {
    if (removeFromPending) {
      const entry = this.pending.get(request.id);
      if (entry) this.clearEntry(entry);
    }
    this.emitter.emit({
      type: "approval.resolved",
      session_id: request.sessionId,
      payload: { request, result },
    });
    return result;
  }

  private clearEntry(entry: PendingEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    this.pending.delete(entry.request.id);
    this.emitPendingChanged(entry.request.sessionId);
  }

  private emitPendingChanged(sessionId: string): void {
    this.emitter.emit({
      type: "approval.pending_changed",
      session_id: sessionId,
      payload: { pending: this.listPendingForSession(sessionId) },
    });
  }
}

export { CompositePolicy };
