// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ConfirmProvider, useConfirm } from "./use-confirm";

// Radix Dialog（shared-ui 的 Dialog 外壳）在 jsdom 里需要这几个 polyfill。
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  document.body.innerHTML = "";
});

function Probe() {
  const { confirm, prompt } = useConfirm();
  const [result, setResult] = useState("none");
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: "删除服务商",
            body: "确定删除「My Proxy」吗？此操作会移除该自定义服务商的 Base URL、模型和密钥配置。",
            confirmLabel: "删除",
            danger: true,
          }).then((ok) => setResult(`confirm:${ok}`));
        }}
      >
        open-confirm
      </button>
      <button
        type="button"
        onClick={() => {
          void prompt({
            title: "添加项目",
            body: "输入项目工作区路径（绝对路径）",
            confirmLabel: "添加",
            input: { placeholder: "/path/to/project" },
          }).then((value) => setResult(`prompt:${value}`));
        }}
      >
        open-prompt
      </button>
      <div data-testid="result">{result}</div>
    </div>
  );
}

function renderProbe(): void {
  render(
    <ConfirmProvider>
      <Probe />
    </ConfirmProvider>,
  );
}

describe("useConfirm", () => {
  it("confirm() resolves true when the confirm button is clicked", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("open-confirm"));

    // 应用内弹窗（不是 window.confirm）：标题 + 正文渲染在 DOM 里。
    expect(await screen.findByText("删除服务商")).toBeTruthy();
    expect(screen.getByText(/确定删除「My Proxy」吗/)).toBeTruthy();

    // danger 确认按钮带 danger 色调。
    const confirmButton = screen.getByRole("button", { name: "删除" });
    expect(confirmButton.getAttribute("data-tone")).toBe("danger");

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("confirm:true");
    });
    // 关闭后弹窗内容从 DOM 卸载。
    await waitFor(() => {
      expect(screen.queryByText("删除服务商")).toBeNull();
    });
  });

  it("confirm() resolves false when cancelled", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("open-confirm"));
    await screen.findByText("删除服务商");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("confirm:false");
    });
  });

  it("prompt() resolves the input string on confirm", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("open-prompt"));

    const input = (await screen.findByPlaceholderText(
      "/path/to/project",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "C:\\dev\\proj" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("prompt:C:\\dev\\proj");
    });
  });

  it("prompt() resolves null when cancelled", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("open-prompt"));
    await screen.findByPlaceholderText("/path/to/project");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("prompt:null");
    });
  });
});
