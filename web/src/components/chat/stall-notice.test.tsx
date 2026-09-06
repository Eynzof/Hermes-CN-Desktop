// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StallNotice } from "./stall-notice";

afterEach(() => cleanup());

describe("StallNotice", () => {
  it("shows the formatted stall duration and interrupts the turn", () => {
    const onInterrupt = vi.fn();
    render(<StallNotice silenceMs={125_000} onInterrupt={onInterrupt} />);
    expect(screen.getByRole("alert").textContent).toContain("无响应");
    fireEvent.click(screen.getByRole("button", { name: /中断/ }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("disables the button while interrupting", () => {
    const onInterrupt = vi.fn();
    render(<StallNotice silenceMs={5_000} onInterrupt={onInterrupt} interrupting />);
    fireEvent.click(screen.getByRole("button", { name: /中断中/ }));
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
