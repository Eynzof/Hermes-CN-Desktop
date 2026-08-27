// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PersonalityPicker, type PersonalityItem } from "./personality-picker";

afterEach(() => cleanup());

const items: PersonalityItem[] = [
  { name: "严谨工程师", definition: { tone: "严谨", style: "分析优先" }, emoji: "🧑‍💻" },
  { name: "温暖助手", definition: { tone: "温暖", style: "共情" }, emoji: "🤗" },
];

describe("PersonalityPicker", () => {
  it("renders all personalities sorted and marks the active one", () => {
    render(<PersonalityPicker personalities={items} activeName="严谨工程师" />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // localeCompare 按拼音排序：温暖助手 在 严谨工程师 之前
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("active-personality-badge").textContent).toBe("严谨工程师");
  });

  it("selects a personality via onClick", () => {
    const onSelect = vi.fn();
    render(<PersonalityPicker personalities={items} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("option", { name: /温暖助手/ }));
    expect(onSelect).toHaveBeenCalledWith("温暖助手", items[1]);
  });

  it("resets to neutral when the reset button is clicked", () => {
    const onReset = vi.fn();
    render(<PersonalityPicker personalities={items} activeName="温暖助手" onReset={onReset} />);
    fireEvent.click(screen.getByRole("button", { name: /Reset to neutral/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no personalities", () => {
    render(<PersonalityPicker personalities={[]} />);
    expect(screen.getByText("No personalities available.")).toBeTruthy();
  });
});
