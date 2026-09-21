// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HermesUIMessage, MessagesResponse } from "@hermes/protocol";
import { mergeHermesUIMessages } from "@/components/chat/message-adapter";
import { rememberSessionMapping } from "@/lib/session-map";
import { activeProfileAtom } from "@/stores/ui";
import { applyGatewayEventAtom, chatRuntimeBySessionAtom, markSessionInterruptedAtom } from "@/stores/chat";
import { useGateway } from "./use-gateway";

vi.mock("@/lib/gateway-client", () => ({
  getGatewayClient: () => ({
    state: "idle", enableAutoReconnect: vi.fn(), disableAutoReconnect: vi.fn(),
    onState: () => () => {}, onAny: () => () => {}, on: () => () => {},
    request: vi.fn().mockResolvedValue({}),
  }),
}));

afterEach(cleanup);
const persistentId = "20260920_190620_42043f";
const gatewayId = "gateway-resumed-profile";
const profile = "legacy070-mac-profile";
const historyKey = ["session-messages", profile, persistentId];
const storedTurn = (id: number, now: number): HermesUIMessage[] => [
  { id: `stored-${id}`, sessionId: persistentId, role: "user", createdAt: now, status: "complete", parts: [{ type: "text", text: "Same question" }], metadata: { persistedId: id } },
  { id: `stored-${id + 1}`, sessionId: persistentId, role: "assistant", createdAt: now + 1000, status: "complete", parts: [{ type: "text", text: "Same answer" }], metadata: { persistedId: id + 1 } },
];
const response = (messages: HermesUIMessage[]): MessagesResponse => ({ session_id: persistentId, messages: [], ui_messages: messages });

function setup() {
  const store = createStore();
  store.set(activeProfileAtom, profile);
  rememberSessionMapping(gatewayId, persistentId);
  const queryClient = new QueryClient();
  const old = storedTurn(1, 100_000);
  queryClient.setQueryData(historyKey, response(old));
  // Same numeric IDs in another profile/session must not supply this boundary.
  queryClient.setQueryData(["session-messages", "default", persistentId], response(storedTurn(91, 100_000)));
  queryClient.setQueryData(["session-messages", profile, "another-session"], response(storedTurn(81, 100_000)));
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></Provider>
  );
  const hook = renderHook(() => useGateway(), { wrapper });
  const messages = () => store.get(chatRuntimeBySessionAtom)[gatewayId]!.messages;
  const complete = () => store.set(applyGatewayEventAtom, {
    type: "message.complete", session_id: gatewayId, payload: { text: "Same answer", status: "complete" },
  });
  return { ...hook, store, queryClient, old, messages, complete };
}

describe("submitted prompt history boundary", () => {
  it("keeps an identical old turn intact until the resumed session's new turn is persisted", () => {
    const { result, messages, old, complete } = setup();
    act(() => { result.current.beginPrompt(gatewayId, "Same question", 200_000); complete(); });
    expect(messages()[0]?.metadata?.historyBoundaryId).toBe("stored-2");
    const before = mergeHermesUIMessages(old, messages());
    expect(before).toEqual([...old, ...messages()]);

    const persisted = [...old, ...storedTurn(3, 200_000)];
    const after = mergeHermesUIMessages(persisted, messages());
    expect(after).toHaveLength(4);
    expect(after.slice(0, 2)).toEqual(old);
    expect(after[2]?.metadata?.persistedId).toBe(3);
    expect(after[3]?.metadata?.persistedId).toBe(4);
  });

  it("matches consecutive identical prompts in order while the message cache is unchanged", () => {
    const { result, messages, old, complete } = setup();
    act(() => { result.current.beginPrompt(gatewayId, "Same question", 200_000); complete(); });
    act(() => { result.current.beginPrompt(gatewayId, "Same question", 300_000); complete(); });
    expect(messages().filter((message) => message.role === "user").map((message) => message.metadata?.historyBoundaryId)).toEqual(["stored-2", "stored-2"]);
    const partial = mergeHermesUIMessages([...old, ...storedTurn(3, 200_000)], messages());
    expect(partial).toHaveLength(6);
    expect(partial.slice(0, 2)).toEqual(old);
    expect(partial[2]?.metadata?.persistedId).toBe(3);
    expect(partial[4]?.metadata?.persistedId).toBeUndefined();
    const completeHistory = mergeHermesUIMessages([...old, ...storedTurn(3, 200_000), ...storedTurn(5, 300_000)], messages());
    expect(completeHistory).toHaveLength(6);
    expect(completeHistory.map((message) => message.metadata?.persistedId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("bounds an uncached first prompt before the following prompt's known history", () => {
    const { result, messages, queryClient, complete } = setup();
    queryClient.removeQueries({ queryKey: historyKey, exact: true });
    act(() => { result.current.beginPrompt(gatewayId, "Same question", 100_000); complete(); });
    expect(messages()[0]?.metadata?.historyBoundaryId).toBeUndefined();

    const firstTurn = storedTurn(1, 100_000);
    queryClient.setQueryData(historyKey, response(firstTurn));
    act(() => { result.current.beginPrompt(gatewayId, "Same question", 200_000); complete(); });
    expect(messages()[2]?.metadata?.historyBoundaryId).toBe("stored-2");
    const before = mergeHermesUIMessages(firstTurn, messages());
    expect(before).toHaveLength(4);
    expect(before.map((message) => message.metadata?.persistedId)).toEqual([1, 2, undefined, undefined]);

    const after = mergeHermesUIMessages([...firstTurn, ...storedTurn(3, 200_000)], messages());
    expect(after).toHaveLength(4);
    expect(after.map((message) => message.metadata?.persistedId)).toEqual([1, 2, 3, 4]);
    expect(after.map((message) => message.createdAt)).toEqual([100_000, 100_000, 200_000, 200_000]);
  });

  it("captures the latest boundary when continuing after a stopped turn", async () => {
    const { result, messages, store, queryClient } = setup();
    act(() => result.current.beginPrompt(gatewayId, "Same question", 200_000));
    act(() => store.set(markSessionInterruptedAtom, gatewayId));
    queryClient.setQueryData(historyKey, response([...storedTurn(1, 100_000), ...storedTurn(3, 200_000)]));
    await act(async () => { await result.current.sendPrompt(gatewayId, "Same question"); });
    const users = messages().filter((message) => message.role === "user");
    expect(users.map((message) => message.metadata?.historyBoundaryId)).toEqual(["stored-2", "stored-4"]);
  });
});
