// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueuePanel } from "./queue-panel";
import type { QueuedPromptEntry } from "@/stores/composer-queue";

afterEach(() => cleanup());

function makeEntry(partial: Partial<QueuedPromptEntry> = {}): QueuedPromptEntry {
  return {
    id: "q1",
    text: "帮我写一个测试",
    attachments: [],
    queuedAt: 0,
    ...partial,
  };
}

describe("QueuePanel", () => {
  it("renders nothing with an empty queue", () => {
    const { container } = render(
      <QueuePanel entries={[]} busy={false} editingId={null} onSendNow={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("collapses / expands the queue list", () => {
    render(
      <QueuePanel
        entries={[makeEntry()]}
        busy={false}
        editingId={null}
        onSendNow={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const head = screen.getByRole("button", { name: /已排队 1 条/ });
    expect(screen.getByText("帮我写一个测试")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText("帮我写一个测试")).toBeNull();
  });

  it("drives edit / send-now / delete actions per entry", () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const onDelete = vi.fn();
    const entry = makeEntry();
    render(
      <QueuePanel entries={[entry]} busy={false} editingId={null} onSendNow={onSendNow} onEdit={onEdit} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑此排队消息" }));
    expect(onEdit).toHaveBeenCalledWith(entry);
    fireEvent.click(screen.getByRole("button", { name: "立即发送此排队消息" }));
    expect(onSendNow).toHaveBeenCalledWith("q1");
    fireEvent.click(screen.getByRole("button", { name: "删除此排队消息" }));
    expect(onDelete).toHaveBeenCalledWith("q1");
  });

  it("disables send-now while the agent is busy", () => {
    const onSendNow = vi.fn();
    render(
      <QueuePanel entries={[makeEntry()]} busy editingId={null} onSendNow={onSendNow} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "立即发送此排队消息" }));
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it("shows attachment count and empty-prompt preview", () => {
    render(
      <QueuePanel
        entries={[makeEntry({ text: "", attachments: [{ id: "a1", name: "x.png" } as unknown as QueuedPromptEntry["attachments"][number]] })]}
        busy={false}
        editingId={null}
        onSendNow={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("仅附件")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});
