// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, useAtomValue } from "jotai";
import type { SessionSummary } from "@hermes/protocol";
import { QuickStart, RECIPES_PANEL } from "./quick-start";
import { RecentTable } from "./recent-table";
import { composerPrefillAtom } from "@/stores/panel";

afterEach(() => cleanup());

function makeSession(id: string): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    model: "fake-model",
    source: "web",
    started_at: 1700000000,
    ended_at: 1700000060,
    end_reason: "done",
    message_count: 1,
    input_tokens: 10,
    output_tokens: 5,
    estimated_cost_usd: null,
  };
}

describe("QuickStart", () => {
  it("fills the composer prefill when a recipe card is clicked", () => {
    function Probe() {
      const prefill = useAtomValue(composerPrefillAtom);
      return <output data-testid="prefill">{prefill?.text ?? ""}</output>;
    }
    render(
      <Provider>
        <QuickStart recipes={[RECIPES_PANEL[0]]} />
        <Probe />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /代码评审/ }));
    expect(screen.getByTestId("prefill").textContent).toBe(RECIPES_PANEL[0].prompt);
  });
});

describe("RecentTable", () => {
  it("opens a session from its row", () => {
    const onOpen = vi.fn();
    const session = makeSession("sess_123");
    render(<RecentTable sessions={[session]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("会话 sess_123"));
    expect(onOpen).toHaveBeenCalledWith(session);
  });

  it("expands a long list and pages through it", () => {
    const onOpen = vi.fn();
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(`sess_${String(i).padStart(3, "0")}`));
    render(<RecentTable sessions={sessions} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /查看全部/ }));
    fireEvent.click(screen.getByRole("button", { name: "第 2 页" }));
    expect(screen.getByText(/21–25 \/ 25/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /收起/ }));
  });
});
