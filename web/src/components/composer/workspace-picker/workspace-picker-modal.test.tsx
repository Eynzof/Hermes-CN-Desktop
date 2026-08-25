// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspacePickerModal } from "./workspace-picker-modal";

vi.mock("@/hooks/use-fs-list", () => ({
  useFsList: () => ({
    data: {
      path: "/home/user/projects",
      home: "/home/user",
      entries: [
        { name: "alpha", path: "/home/user/projects/alpha", is_dir: true },
        { name: "beta", path: "/home/user/projects/beta", is_dir: true },
      ],
    },
    isFetching: false,
  }),
}));

afterEach(() => cleanup());

describe("WorkspacePickerModal", () => {
  it("confirms the resolved directory", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /选择此目录/ }));
    expect(onConfirm).toHaveBeenCalledWith("/home/user/projects");
  });

  it("cancels via the close button", () => {
    const onCancel = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭目录选择" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("jumps to a manually typed path and navigates entries", () => {
    const onConfirm = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/粘贴 home 内路径/), { target: { value: "/home/user/other" } });
    fireEvent.click(screen.getByRole("button", { name: /跳转/ }));
    // after navigation the mock still returns the same data path, so confirm uses resolved path
    fireEvent.click(screen.getByRole("button", { name: /选择此目录/ }));
    expect(onConfirm).toHaveBeenCalledWith("/home/user/projects");
  });
});
