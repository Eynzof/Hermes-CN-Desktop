// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubRadixGlobals } from "@/test-utils/radix";
import { REASONING_EFFORT_LABELS } from "@/lib/reasoning-effort";
import { ReasoningEffortMenu } from "./reasoning-effort-menu";

stubRadixGlobals();
beforeEach(() => cleanup());

describe("ReasoningEffortMenu", () => {
  it("selects an effort level and reports it", () => {
    const onSelect = vi.fn();
    render(<ReasoningEffortMenu value="medium" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /思考/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${REASONING_EFFORT_LABELS.high}$`) }));
    expect(onSelect).toHaveBeenCalledWith("high");
  });

  it("shows the default hint when unset", () => {
    const onSelect = vi.fn();
    render(<ReasoningEffortMenu value={null} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /思考/ }).textContent).toContain("默认");
  });
});
