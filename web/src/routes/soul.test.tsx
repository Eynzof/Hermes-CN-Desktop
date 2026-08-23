// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const soulState = vi.hoisted(() => {
  const state = {
    data: { content: "# 人格\n初始内容", exists: true },
    error: null as Error | null,
    loading: false,
    refetch: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => undefined),
  };
  return {
    get data() {
      return state.data;
    },
    get error() {
      return state.error;
    },
    get loading() {
      return state.loading;
    },
    refetch: state.refetch,
    mutate: state.mutate,
    mutateAsync: state.mutateAsync,
    __setData(content: string, exists = true) {
      state.data = { content, exists };
    },
    __setError(error: Error | null) {
      state.error = error;
    },
    __setLoading(loading: boolean) {
      state.loading = loading;
    },
    __reset() {
      state.data = { content: "# 人格\n初始内容", exists: true };
      state.error = null;
      state.loading = false;
      state.refetch.mockReset();
      state.mutate.mockReset();
      state.mutateAsync.mockReset();
      state.mutateAsync.mockResolvedValue(undefined);
    },
  };
});

vi.mock("@/hooks/use-soul", () => ({
  SOUL_CHAR_LIMIT: 20_000,
  useSoul: () => ({
    data: soulState.data,
    error: soulState.error,
    isLoading: soulState.loading,
    isFetching: false,
    refetch: soulState.refetch,
  }),
  useSaveSoul: () => ({
    mutate: soulState.mutate,
    mutateAsync: soulState.mutateAsync,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

vi.mock("@/components/persona/persona-market-panel", () => ({
  PersonaMarketPanel: (props: { onApply: (prompt: string) => Promise<void> }) => (
    <button type="button" onClick={() => void props.onApply("市场人格提示词")}>
      apply-market-persona
    </button>
  ),
}));

import { HermesPersonaEditor, HERMES_PERSONA_TAB_LABEL, SoulRoute } from "./soul";

describe("HermesPersonaEditor", () => {
  afterEach(() => cleanup());
  it("keeps editing while removing preview and template insertion controls", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text="# 我的 Hermes 人格"
        dirty
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(html).toContain("编辑");
    expect(html).toContain("# 我的 Hermes 人格");
    expect(html).toContain("保存人格");
    expect(html).not.toContain("预览");
    expect(html).not.toContain("插入模板");
  });

  it("explains the create flow when the soul file does not exist yet", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists={false}
        text=""
        dirty={false}
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain("尚未创建，保存后将在当前档案生成 SOUL.md");
    expect(html).not.toContain("已保存");
  });

  it("shows the saved badge only after a successful save", () => {
    const saved = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text="x"
        dirty={false}
        over={false}
        saving={false}
        saved
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const notSaved = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text="x"
        dirty
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(saved).toContain("已保存");
    expect(notSaved).not.toContain("已保存");
  });

  it("renders the live character counter and the over-limit hint", () => {
    const over = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text={">".repeat(20_001)}
        dirty
        over
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(over).toContain("20,001 / 20,000 字符");
    expect(over).toContain("超出部分将在注入时截断");
    expect(over).toContain('data-over="true"');
  });

  it("disables the save button until the editor is dirty", () => {
    const clean = ReactDOMServer.renderToStaticMarkup(
      <HermesPersonaEditor
        exists
        text="x"
        dirty={false}
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(clean).toContain("disabled");
  });

  it("fires onTextChange with the new textarea value", () => {
    const onTextChange = vi.fn();
    render(
      <HermesPersonaEditor
        exists
        text="old"
        dirty
        over={false}
        saving={false}
        saved={false}
        onTextChange={onTextChange}
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new text" } });
    expect(onTextChange).toHaveBeenCalledWith("new text");
  });

  it("calls onSave when the save button is clicked", () => {
    const onSave = vi.fn();
    render(
      <HermesPersonaEditor
        exists
        text="x"
        dirty
        over={false}
        saving={false}
        saved={false}
        onTextChange={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存人格" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("SoulRoute", () => {
  beforeEach(() => {
    soulState.__reset();
    cleanup();
  });

  it("shows the loading state while the soul query is loading", () => {
    soulState.__setLoading(true);
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("正在加载人格…")).toBeTruthy();
  });

  it("shows the profile chip and refresh button", () => {
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    expect(screen.getByTitle("当前档案").textContent).toBe("default");
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
    expect(soulState.refetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces the soul load error", () => {
    soulState.__setError(new Error("读取 SOUL.md 失败"));
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("读取 SOUL.md 失败")).toBeTruthy();
  });

  it("starts on the persona market tab and switches to the custom editor", () => {
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    const marketTab = screen.getByRole("tab", { name: /人格市场/ });
    const customTab = screen.getByRole("tab", { name: HERMES_PERSONA_TAB_LABEL });
    expect(marketTab.getAttribute("aria-selected")).toBe("true");
    expect(customTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(customTab);
    expect(customTab.getAttribute("aria-selected")).toBe("true");
    expect(marketTab.getAttribute("aria-selected")).toBe("false");
  });

  it("backfills the editor with the backend content when not dirty", async () => {
    soulState.__setData("# 人格\n来自后端");
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("tab", { name: HERMES_PERSONA_TAB_LABEL }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("# 人格\n来自后端"));
  });

  it("marks the editor dirty on edit and saves via the mutation", async () => {
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("tab", { name: HERMES_PERSONA_TAB_LABEL }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "新的人格内容" } });

    const saveButton = screen.getByRole("button", { name: "保存人格" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    expect(soulState.mutate).toHaveBeenCalledWith("新的人格内容", expect.any(Object));
  });

  it("applies a persona from the market and writes it into the editor", async () => {
    render(
      <MemoryRouter>
        <SoulRoute />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "apply-market-persona" }));
    await waitFor(() => expect(soulState.mutateAsync).toHaveBeenCalledWith("市场人格提示词"));

    fireEvent.click(screen.getByRole("tab", { name: HERMES_PERSONA_TAB_LABEL }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("市场人格提示词"));
  });
});
