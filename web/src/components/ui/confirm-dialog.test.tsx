// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmDialog } from "./confirm-dialog";

stubRadixGlobals();
beforeEach(() => cleanup());

describe("ConfirmDialog", () => {
  it("resolves true on 确定 and false on 取消", () => {
    const onResolve = vi.fn();
    render(
      <ConfirmDialog
        spec={{ title: "删除确认", body: "确定要删除吗？", confirmLabel: "删除", cancelLabel: "取消", danger: true }}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText("删除确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onResolve).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it("resolves the typed input string in input mode", () => {
    const onResolve = vi.fn();
    render(
      <ConfirmDialog
        spec={{
          title: "重命名",
          body: "输入新名称",
          input: { label: "名称", placeholder: "新名称", initialValue: "abc" },
          confirmLabel: "保存",
          cancelLabel: "取消",
        }}
        onResolve={onResolve}
      />,
    );
    const input = screen.getByPlaceholderText("新名称") as HTMLInputElement;
    expect(input.value).toBe("abc");
    fireEvent.change(input, { target: { value: "def" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(onResolve).toHaveBeenCalledWith("def");
  });

  it("resolves null on cancel in input mode and Enter submits", () => {
    const onResolve = vi.fn();
    render(
      <ConfirmDialog
        spec={{ title: "输入", input: { label: "值", placeholder: "值" }, confirmLabel: "确定", cancelLabel: "取消" }}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onResolve).toHaveBeenCalledWith(null);
    fireEvent.keyDown(screen.getByPlaceholderText("值"), { key: "Enter" });
    expect(onResolve).toHaveBeenCalledWith("");
  });
});
