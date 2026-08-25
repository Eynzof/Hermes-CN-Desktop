// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorCard } from "./error-card";
import { ApiError } from "@/lib/wander-memory";
import { WanderMemoryToastProvider, useWanderMemoryToast } from "./toast";

afterEach(() => cleanup());

describe("ErrorCard", () => {
  it("retries and dismisses via its buttons", () => {
    const retry = vi.fn();
    const onDismiss = vi.fn();
    render(<ErrorCard error={new ApiError("collision_lock", "locked", 409)} retry={retry} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("WanderMemoryToastProvider", () => {
  function Probe() {
    const { push } = useWanderMemoryToast();
    return (
      <button type="button" onClick={() => push("success", "保存成功")}>
        push
      </button>
    );
  }

  it("renders a toast and dismisses it via its close button", () => {
    render(
      <WanderMemoryToastProvider>
        <Probe />
      </WanderMemoryToastProvider>,
    );
    expect(screen.queryByText("保存成功")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.getByText("保存成功")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("保存成功")).toBeNull();
  });
});
