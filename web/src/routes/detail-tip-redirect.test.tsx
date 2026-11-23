// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { HashRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DetailRoute } from "./detail";
import { activeProfileAtom, activeSessionIdAtom, rightRailVisibleAtom, sessionTipRedirectAtom } from "@/stores/ui";

vi.mock("@/components/chat/goose-composer", () => ({ GooseComposer: () => null }));
vi.mock("@/components/chat/message-timeline", () => ({
  MessageTimeline: ({ messages }: { messages: Array<{ id: string; text: string }> }) =>
    messages.map((message) => <p key={message.id}>{message.text}</p>),
}));
vi.mock("@/components/chat/preview-rail/preview-rail", () => ({ PreviewRail: () => null }));
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const oldId = "20261123_001415_aaaaaa";
const tipId = "20261123_002215_bbbbbb";

function openDetail(store: ReturnType<typeof createStore>, urlId: string, rows: [string, string][]) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  for (const [id, text] of rows) {
    client.setQueryData(["session-messages", store.get(activeProfileAtom), id], {
      session_id: id, messages: [{ id: 1, session_id: id, role: "assistant", content: text, timestamp: 101 }],
    });
  }
  window.history.replaceState(null, "", "#/tasks/" + urlId);
  render(
    <Provider store={store}>
      <QueryClientProvider client={client}>
        <HashRouter><Routes><Route path="/tasks/:taskId" element={<DetailRoute />} /></Routes></HashRouter>
      </QueryClientProvider>
    </Provider>,
  );
}

it("follows the compression tip once and shows the new chain with overlapping message IDs", async () => {
  const store = createStore();
  store.set(activeSessionIdAtom, oldId);
  store.set(rightRailVisibleAtom, false);
  openDetail(store, oldId, [[oldId, "压缩前的回复"], [tipId, "延续会话的回复"]]);
  await screen.findByText("压缩前的回复");
  const replace = vi.spyOn(window.history, "replaceState");
  const changes: Array<string | null> = [];
  const unsubscribe = store.sub(activeSessionIdAtom, () => {
    const selected = store.get(activeSessionIdAtom);
    changes.push(selected);
    // Fail at the first bounce, before React schedules another redirect.
    expect(selected).toBe(tipId);
  });
  try {
    act(() => store.set(sessionTipRedirectAtom, { [oldId]: tipId }));
    await screen.findByText("延续会话的回复");
    expect(screen.queryByText("压缩前的回复")).toBeNull();
    expect(window.location.hash).toBe("#/tasks/" + tipId);
    expect(changes).toEqual([tipId]);
    expect(replace).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it("keeps a newly opened conversation when the previous selection has a pending redirect", async () => {
  const otherId = "20261123_003415_cccccc";
  const store = createStore();
  store.set(activeSessionIdAtom, oldId);
  store.set(rightRailVisibleAtom, false);
  store.set(sessionTipRedirectAtom, { [oldId]: tipId });
  openDetail(store, otherId, [[otherId, "刚打开的会话"], [tipId, "上一会话的延续"]]);
  await screen.findByText("刚打开的会话");
  expect(window.location.hash).toBe("#/tasks/" + otherId);
  expect(store.get(activeSessionIdAtom)).toBe(otherId);
});
