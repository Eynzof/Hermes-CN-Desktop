import { useState } from "react";
import type { ApprovalRequest, ApprovalScope } from "@hermes/agent-core";
import s from "./approval-panel.module.css";

export type ApprovalChoice = ApprovalScope | "deny";

export interface ApprovalPanelProps {
  /** Requests awaiting user review. Only the first is shown at a time. */
  pending: ApprovalRequest[];
  /** Called when the user makes a decision for the visible request. */
  onDecide: (
    requestId: string,
    choice: ApprovalChoice,
    feedback?: string,
  ) => void;
  /** Called when the user wants to dismiss / cancel all pending requests. */
  onCancelAll?: () => void;
}

/**
 * Modal approval panel for dangerous tool calls.
 *
 * Renders the oldest pending request with choices:
 * - Approve once
 * - Approve for this session
 * - Always approve
 * - Reject
 * - Reject with feedback
 */
export function ApprovalPanel({ pending, onDecide, onCancelAll }: ApprovalPanelProps) {
  const [feedback, setFeedback] = useState("");
  const request = pending[0];

  if (!request) return null;

  const handle = (choice: ApprovalChoice) => {
    onDecide(request.id, choice, feedback.trim() || undefined);
    setFeedback("");
  };

  return (
    <div className={s.panel} role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className={s.card}>
        <h3 id="approval-title" className={s.header}>
          Approval required: {request.toolName}
        </h3>
        <span className={s.badge}>Danger: {request.dangerLevel}</span>
        {request.description && (
          <p className={s.description}>{request.description}</p>
        )}
        {request.toolArgs && (
          <pre className={s.args}>{request.toolArgs}</pre>
        )}
        <textarea
          className={s.feedback}
          placeholder="Optional feedback (included with reject or conditional approve)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
        />
        <div className={s.actions}>
          <button
            type="button"
            className={`${s.button} ${s.primary}`}
            onClick={() => handle("once")}
          >
            Approve once
          </button>
          <button
            type="button"
            className={s.button}
            onClick={() => handle("session")}
          >
            Approve for session
          </button>
          <button
            type="button"
            className={s.button}
            onClick={() => handle("always")}
          >
            Always approve
          </button>
          <button
            type="button"
            className={`${s.button} ${s.danger}`}
            onClick={() => handle("deny")}
          >
            Reject
          </button>
          {onCancelAll && (
            <button type="button" className={s.button} onClick={onCancelAll}>
              Cancel all
            </button>
          )}
        </div>
        {pending.length > 1 && (
          <div className={s.count}>{pending.length - 1} more pending</div>
        )}
      </div>
    </div>
  );
}
