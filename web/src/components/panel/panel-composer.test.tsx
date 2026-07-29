import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connect: vi.fn(),
    getModelOptions: vi.fn(),
    completePath: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    adoptCreatedSession: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-create-and-send-session", () => ({
  useCreateAndSendSession: () => vi.fn(),
}));

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({ data: { agent: { reasoning_effort: "low" } } }),
  useModelInfo: () => ({ data: { model: "test-model", provider: "test-provider" } }),
  useSaveConfig: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/use-model-options", () => ({
  useModelOptions: () => ({ data: null }),
}));

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({
    data: [],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({ data: { sessions: [] } }),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

import { PanelComposer } from "./panel-composer";

describe("PanelComposer", () => {
  it("在新任务工具栏显示当前推理强度入口", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter>
        <PanelComposer />
      </MemoryRouter>,
    );

    expect(html).toContain("思考强度：低");
    expect(html).toContain(">思考<");
  });
});
