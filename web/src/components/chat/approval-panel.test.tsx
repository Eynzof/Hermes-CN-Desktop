// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ApprovalPanel } from "./approval-panel";
import type { ApprovalRequest } from "@hermes/agent-core";

function makeRequest(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    sessionId: "s-1",
    toolName: "execute_code",
    dangerLevel: "high",
    description: "Run python code",
    toolArgs: 'print("hello")',
    ...partial,
  };
}

describe("ApprovalPanel", () => {
  it("renders nothing when there are no pending requests", () => {
    const { container } = render(<ApprovalPanel pending={[]} onDecide={vi.fn()} />);
    expect(container.firstChild).not.toBeTruthy();
  });

  it("shows the pending request details", () => {
    cleanup();
    render(<ApprovalPanel pending={[makeRequest()]} onDecide={vi.fn()} />);
    expect(screen.getByText(/Approval required: execute_code/)).toBeTruthy();
    expect(screen.getByText(/Run python code/)).toBeTruthy();
    expect(screen.getByText(/print\("hello"\)/)).toBeTruthy();
  });

  it("emits approve-once with optional feedback", () => {
    cleanup();
    const onDecide = vi.fn();
    render(<ApprovalPanel pending={[makeRequest()]} onDecide={onDecide} />);
    fireEvent.change(screen.getByPlaceholderText(/Optional feedback/), {
      target: { value: "Looks safe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Approve once/ }));
    expect(onDecide).toHaveBeenCalledWith("req-1", "once", "Looks safe");
  });

  it("emits reject without feedback", () => {
    cleanup();
    const onDecide = vi.fn();
    render(<ApprovalPanel pending={[makeRequest()]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onDecide).toHaveBeenCalledWith("req-1", "deny", undefined);
  });

  it("emits approve-session and always choices", () => {
    cleanup();
    const onDecide = vi.fn();
    render(<ApprovalPanel pending={[makeRequest()]} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve for session/ }));
    fireEvent.click(screen.getByRole("button", { name: /Always approve/ }));
    expect(onDecide).toHaveBeenCalledWith("req-1", "session", undefined);
    expect(onDecide).toHaveBeenCalledWith("req-1", "always", undefined);
  });

  it("shows additional pending count", () => {
    cleanup();
    render(<ApprovalPanel pending={[makeRequest(), makeRequest({ id: "req-2" })]} onDecide={vi.fn()} />);
    expect(screen.getByText(/1 more pending/)).toBeTruthy();
  });

  it("calls onCancelAll when cancel all is clicked", () => {
    cleanup();
    const onCancelAll = vi.fn();
    render(
      <ApprovalPanel pending={[makeRequest()]} onDecide={vi.fn()} onCancelAll={onCancelAll} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel all/ }));
    expect(onCancelAll).toHaveBeenCalled();
  });
});
