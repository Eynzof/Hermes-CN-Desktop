// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGateway } from "@/hooks/use-gateway";
import { readComposerDraft } from "@/lib/composer-drafts";
import { humanizeGatewayError } from "@/lib/gateway-result";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { PanelComposer } from "./panel-composer";

vi.mock("@/hooks/use-gateway", () => ({ useGateway: vi.fn() }));
vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({ data: {} }),
  useSaveConfig: () => ({}),
  useModelInfo: () => ({ data: {} }),
}));
vi.mock("@/hooks/use-model-options", () => ({ useModelOptions: () => ({}) }));
vi.mock("@/hooks/use-skills", () => ({ useSkills: () => ({}) }));
vi.mock("@/hooks/use-sessions", () => ({ useSessions: () => ({}) }));
vi.mock("@/hooks/use-profiles", () => ({ useActiveProfileName: () => "default" }));
vi.mock("@/lib/last-used-model", () => ({
  useLastUsedModel: () => ({ model: "chosen", provider: "chosen-provider" }),
}));

const gateway = {
  createSession: vi.fn(async () => "test-session"), beginPrompt: vi.fn(), failPrompt: vi.fn(),
  setSessionTitle: vi.fn(async () => undefined), setSessionModel: vi.fn(),
  sendPrompt: vi.fn(), setSessionReasoningEffort: vi.fn(),
  attachFile: vi.fn(async () => ({ path: "/fixture/sample.txt", name: "sample.txt" })),
};
function newTask() {
  return readComposerDraft({ kind: "new", profile: "default" });
}
function compose(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: text } });
}
function renderPanel() {
  render(<MemoryRouter><Routes>
    <Route path="/" element={<PanelComposer />} />
    <Route path="/tasks/:id" element={<Link to="/">新建对话</Link>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetUiStoreForTests();
  vi.mocked(useGateway).mockReturnValue(gateway as unknown as ReturnType<typeof useGateway>);
});
afterEach(cleanup);

it.each([false, true])("waits for acknowledgement before clearing only the submitted draft (new draft %s)", async (edit) => {
  let accept!: () => void;
  gateway.sendPrompt.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
  renderPanel();
  compose("  first message  ");
  const send = screen.getByRole("button", { name: "发送消息" });
  fireEvent.click(send);
  fireEvent.click(send);
  await screen.findByRole("link", { name: "新建对话" });
  await waitFor(() => expect(gateway.sendPrompt).toHaveBeenCalledTimes(1));
  expect(newTask()).toBe("  first message  ");
  if (edit) {
    fireEvent.click(screen.getByRole("link", { name: "新建对话" }));
    compose("a newer draft");
  }
  await act(async () => accept());
  expect(newTask()).toBe(edit ? "a newer draft" : "");
});

it.each(["model", "submit"])("keeps the original draft and reports attachment count on %s failure", async stage => {
  const failure = Error("connection closed");
  if (stage === "model") gateway.setSessionModel.mockRejectedValueOnce(failure);
  else gateway.sendPrompt.mockRejectedValueOnce(failure);
  renderPanel();
  compose("original message");
  const files = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(files, { target: { files: [new File(["fixture"], "sample.txt")] } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(gateway.failPrompt).toHaveBeenCalledTimes(1));
  const error = gateway.failPrompt.mock.calls[0][1];
  expect(humanizeGatewayError(error)).toContain("新建对话");
  expect(humanizeGatewayError(error)).toContain("1 个附件需要重新添加");
  expect(gateway.sendPrompt).toHaveBeenCalledTimes(stage === "model" ? 0 : 1);
  fireEvent.click(screen.getByRole("link", { name: "新建对话" }));
  expect((screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement).value).toBe("original message");
  expect(readComposerDraft({ kind: "new", profile: "other" })).toBe("");
});
