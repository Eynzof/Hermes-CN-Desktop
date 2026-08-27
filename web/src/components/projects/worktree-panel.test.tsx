// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorktreePanel } from "./worktree-panel";

const worktreesMock = vi.hoisted(() => ({
  worktrees: [
    { path: "C:/repo", branch: "main", isMain: true, locked: false, detached: false },
    { path: "C:/repo-wt", branch: "hermes/feat", isMain: false, locked: false, detached: false },
  ],
  branches: [
    { name: "main", checkedOut: true, isDefault: true },
    { name: "feat", checkedOut: false, isDefault: false },
  ],
  status: { branch: "main", ahead: 0, behind: 0, added: 1, removed: 0, changed: 2, detached: false },
  loading: false,
  isRepo: true,
  busy: false,
  error: null,
  refresh: vi.fn(),
  addWorktree: vi.fn(async () => true),
  checkoutBranch: vi.fn(async () => true),
  removeWorktree: vi.fn(async () => true),
  switchBranch: vi.fn(async () => true),
  dismissError: vi.fn(),
}));

vi.mock("@/hooks/use-worktrees", () => ({
  useWorktrees: () => worktreesMock,
}));

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // The panel hides unless the desktop git bridge exists.
  Object.defineProperty(window, "hermesDesktop", {
    configurable: true,
    value: {
      git: { listWorktrees: vi.fn() },
      openWorkspacePath: vi.fn(),
    },
  });
});

describe("WorktreePanel", () => {
  it("creates a worktree from the new-name input", () => {
    render(<WorktreePanel repoPath="C:/repo" />);
    fireEvent.change(screen.getByPlaceholderText(/新建工作树/), { target: { value: "my-feature" } });
    fireEvent.click(screen.getByRole("button", { name: /新建/ }));
    expect(worktreesMock.addWorktree).toHaveBeenCalledWith("my-feature");
  });

  it("refreshes and deletes a non-main worktree through confirm", async () => {
    render(<WorktreePanel repoPath="C:/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "刷新工作树" }));
    expect(worktreesMock.refresh).toHaveBeenCalledTimes(1);

    const deleteButtons = screen.getAllByRole("button", { name: "删除工作树" });
    const enabledDelete = deleteButtons.find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledDelete).toBeTruthy();
    fireEvent.click(enabledDelete as HTMLButtonElement);
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => expect(worktreesMock.removeWorktree).toHaveBeenCalledWith("C:/repo-wt"));
  });

  it("checks out and switches unchecked branches", () => {
    render(<WorktreePanel repoPath="C:/repo" />);
    fireEvent.click(screen.getByRole("button", { name: /检出为工作树/ }));
    expect(worktreesMock.checkoutBranch).toHaveBeenCalledWith("feat");
    fireEvent.click(screen.getByRole("button", { name: /^切换$/ }));
    expect(worktreesMock.switchBranch).toHaveBeenCalledWith("feat");
  });
});
