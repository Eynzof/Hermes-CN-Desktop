// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MemoryItem } from "@/lib/wander-memory";
import { MemoryCard } from "./memory-card";

const item: MemoryItem = {
  id: "abc123def4567890",
  memory: "用户偏好 TypeScript，修改前先跑 typecheck",
  metadata: {
    type: "fact",
    tags: ["dev", "style"],
    updated_at: "2025-01-02 10:00",
  },
};

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("MemoryCard", () => {
  it("renders the memory text as a plain text node (no HTML injection)", () => {
    const { container } = render(<MemoryCard item={item} />);

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(item.memory);
    // textContent === innerHTML proves a text node — never dangerouslySetInnerHTML.
    expect(paragraph?.innerHTML).toBe(item.memory);
    expect(screen.getByText(item.memory)).toBeTruthy();
  });

  it("renders markup-looking text literally without creating elements", () => {
    const hostile: MemoryItem = {
      id: "hostile01",
      memory: '<img src="x" onerror="window.pwned=1"> <b>bold</b>',
      metadata: {},
    };
    const { container } = render(<MemoryCard item={hostile} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(hostile.memory)).toBeTruthy();
  });

  it("copies the full memory id via the copy button and shows 已复制", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    render(<MemoryCard item={item} />);

    fireEvent.click(screen.getByRole("button", { name: /abc123de/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(item.id);
    expect(await screen.findByText("已复制")).toBeTruthy();
  });

  it("shows metadata chips and pulls updated_at out into an updated-at line", () => {
    render(<MemoryCard item={item} />);

    expect(screen.getByText("type=fact")).toBeTruthy();
    expect(screen.getByText('tags=["dev","style"]')).toBeTruthy();
    // updated_at is surfaced as a line, not a chip.
    expect(screen.getByText(/更新于 2025-01-02 10:00/)).toBeTruthy();
    expect(screen.queryByText(/updated_at=/)).toBeNull();
  });

  it("calls onDelete with the item id from an accessible delete button", () => {
    const onDelete = vi.fn();
    render(<MemoryCard item={item} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "删除记忆 abc123de" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(item.id);
  });

  it("disables the delete button while a delete is pending", () => {
    const onDelete = vi.fn();
    render(<MemoryCard item={item} onDelete={onDelete} deleting />);

    const button = screen.getByRole("button", { name: "删除记忆 abc123de" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onView when the JSON action is clicked", () => {
    const onView = vi.fn();
    render(<MemoryCard item={item} onView={onView} />);

    fireEvent.click(screen.getByRole("button", { name: "查看记忆 abc123de" }));
    expect(onView).toHaveBeenCalledWith(item.id);
  });

  it("renders a collision line inside the card when a collision summary is given", () => {
    const { container } = render(
      <MemoryCard
        item={item}
        collision={{ deleted: 1, merged: 2, stored_new: false, reason: "overlap" }}
      />,
    );

    expect(container.textContent).toContain("与 3 条既有记忆冲突");
  });
});
