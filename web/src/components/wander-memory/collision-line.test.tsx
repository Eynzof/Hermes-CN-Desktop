// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CollisionSummary } from "@/lib/wander-memory";
import { CollisionLine } from "./collision-line";

beforeEach(() => {
  document.body.innerHTML = "";
});

const conflict: CollisionSummary = {
  deleted: 1,
  merged: 2,
  stored_new: true,
  reason: "similar content",
};

describe("CollisionLine", () => {
  it("renders a clean line when nothing conflicted and the item was stored", () => {
    render(
      <CollisionLine collision={{ deleted: 0, merged: 0, stored_new: true, reason: "" }} />,
    );

    expect(screen.getByText(/collision: none/)).toBeTruthy();
    expect(screen.getByText(/已直接存储/)).toBeTruthy();
  });

  it("shows the affected count and merge/delete breakdown", () => {
    render(<CollisionLine collision={conflict} />);

    expect(screen.getByText("与 3 条既有记忆冲突")).toBeTruthy();
    expect(screen.getByText(/合并 2 条，删除 1 条/)).toBeTruthy();
    expect(screen.getByText(/similar content/)).toBeTruthy();
  });

  it("flags when the memory was NOT stored (fail-closed)", () => {
    render(<CollisionLine collision={{ ...conflict, stored_new: false }} />);

    expect(screen.getByText("未存储")).toBeTruthy();
  });

  it("renders the snippet list when provided", () => {
    render(<CollisionLine collision={conflict} snippets={["旧记忆片段 A", "旧记忆片段 B"]} />);

    expect(screen.getByText("旧记忆片段 A")).toBeTruthy();
    expect(screen.getByText("旧记忆片段 B")).toBeTruthy();
  });

  it("renders no action buttons without callbacks", () => {
    render(<CollisionLine collision={conflict} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invokes accept and ignore callbacks", () => {
    const onAccept = vi.fn();
    const onIgnore = vi.fn();
    render(<CollisionLine collision={conflict} onAccept={onAccept} onIgnore={onIgnore} />);

    fireEvent.click(screen.getByRole("button", { name: "接受冲突" }));
    expect(onAccept).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  it("disables the action buttons while an operation is pending", () => {
    const onAccept = vi.fn();
    const onIgnore = vi.fn();
    render(<CollisionLine collision={conflict} onAccept={onAccept} onIgnore={onIgnore} pending />);

    const accept = screen.getByRole("button", { name: "接受冲突" }) as HTMLButtonElement;
    const ignore = screen.getByRole("button", { name: "忽略" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(ignore.disabled).toBe(true);
  });
});
