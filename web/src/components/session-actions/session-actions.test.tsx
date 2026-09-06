// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Popover } from "@hermes/shared-ui";
import type { SessionSummary } from "@hermes/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import {
  SessionBranchErrorModal,
  SessionDeleteModal,
  SessionExportErrorModal,
  SessionRenameModal,
  SessionRowMenu,
} from "@/components/session-actions";

stubRadixGlobals();
beforeEach(() => cleanup());

function makeSession(partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess_1234567890",
    title: "测试会话",
    model: "fake-model",
    source: "web",
    started_at: 1700000000,
    ended_at: 1700000060,
    end_reason: "done",
    message_count: 3,
    input_tokens: 100,
    output_tokens: 50,
    estimated_cost_usd: null,
    ...partial,
  };
}

function renderMenu(props: Partial<Parameters<typeof SessionRowMenu>[0]> = {}) {
  const onTogglePin = vi.fn();
  const onRename = vi.fn();
  const onBranch = vi.fn();
  const onExport = vi.fn();
  const onArchive = vi.fn();
  const onUnarchive = vi.fn();
  const onDelete = vi.fn();
  render(
    <Popover.Root open>
      <Popover.Trigger asChild>
        <button type="button">⋯</button>
      </Popover.Trigger>
      <SessionRowMenu
        pinned={false}
        onTogglePin={onTogglePin}
        onRename={onRename}
        onBranch={onBranch}
        onExport={onExport}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        {...props}
      />
    </Popover.Root>,
  );
  return { onTogglePin, onRename, onBranch, onExport, onArchive, onUnarchive, onDelete };
}

describe("SessionRowMenu", () => {
  it("invokes every session action through its menu item", () => {
    const handlers = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /置顶/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /重命名/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /分叉/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /导出 JSON/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /归档/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
    expect(handlers.onTogglePin).toHaveBeenCalledTimes(1);
    expect(handlers.onRename).toHaveBeenCalledTimes(1);
    expect(handlers.onBranch).toHaveBeenCalledTimes(1);
    expect(handlers.onExport).toHaveBeenCalledTimes(1);
    expect(handlers.onArchive).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows 取消置顶 for a pinned session and disables actions when disabled", () => {
    const handlers = renderMenu({ pinned: true, disabled: true });
    expect(screen.getByRole("menuitem", { name: /取消置顶/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /重命名/ }));
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it("swaps 归档 to 取消归档 in the archived scope", () => {
    const handlers = renderMenu({ archived: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /取消归档/ }));
    expect(handlers.onUnarchive).toHaveBeenCalledTimes(1);
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });
});

describe("SessionDeleteModal", () => {
  it("confirms single and bulk deletes, cancels without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <SessionDeleteModal sessions={[makeSession()]} deleting={false} onClose={onClose} onConfirm={onConfirm} />,
    );
    expect(screen.getByText("删除会话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /确认删除/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <SessionDeleteModal
        sessions={[makeSession(), makeSession({ id: "sess_222" })]}
        deleting={false}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("批量删除会话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("SessionRenameModal", () => {
  it("submits the typed value and shows errors while saving is locked", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <SessionRenameModal
        value="新名字"
        saving={false}
        error=""
        onChange={onChange}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("新名字"), { target: { value: "更新的名字" } });
    expect(onChange).toHaveBeenCalledWith("更新的名字");
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows the error and disables buttons while saving", () => {
    const onSubmit = vi.fn();
    render(
      <SessionRenameModal
        value="x"
        saving
        error="保存失败"
        onChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText("保存失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("Session error modals", () => {
  it("closes the branch-error modal via 知道了", () => {
    const onClose = vi.fn();
    render(<SessionBranchErrorModal error="git 分叉失败" onClose={onClose} />);
    expect(screen.getByText("会话分叉失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /知道了/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes the export-error modal via 知道了", () => {
    const onClose = vi.fn();
    render(<SessionExportErrorModal error="导出失败" onClose={onClose} />);
    expect(screen.getByText("导出会话失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /知道了/ }));
    expect(onClose).toHaveBeenCalled();
  });
});
