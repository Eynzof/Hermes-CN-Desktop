// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./error-boundary";

afterEach(() => cleanup());

function Bomb(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeTruthy();
  });

  it("catches render errors and offers 重试 / 刷新页面", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("页面出现了错误")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    const retry = screen.getByRole("button", { name: /重试/ });
    fireEvent.click(retry);
    // After retry the boundary clears the error and re-renders children (bomb again).
    expect(screen.getByText("页面出现了错误")).toBeTruthy();
    spy.mockRestore();
  });

  it("reloads the page via 刷新页面", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /刷新页面/ }));
    expect(reload).toHaveBeenCalled();
    spy.mockRestore();
  });
});
