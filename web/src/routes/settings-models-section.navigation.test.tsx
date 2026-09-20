// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HashRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ModelOnboardingDialog } from "@/components/app-shell/model-onboarding-dialog";
import { BUILTIN_PROVIDER_CATALOG } from "@/lib/provider-catalog";
import { ConfirmProvider } from "@/lib/use-confirm";
import { ModelsSection } from "./settings-models-section";

const config = {};
const modelInfo = { model: "", provider: "", effective_context_length: 0 };
const envVars = {};

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({ data: config, isLoading: false }),
  useModelInfo: () => ({ data: modelInfo, isLoading: false, isError: false }),
  useSaveConfig: () => ({}),
}));
vi.mock("@/hooks/use-env", () => ({
  useEnvVars: () => ({ data: envVars, isLoading: false }),
  useSetEnv: () => ({}),
  useDeleteEnv: () => ({}),
  useRevealEnv: () => ({}),
}));
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({}) }));
vi.mock("@/hooks/use-provider-models", () => ({ useProviderModels: () => ({}) }));
vi.mock("@/hooks/use-provider-catalog", () => ({
  useProviderCatalog: () => ({ catalog: BUILTIN_PROVIDER_CATALOG, message: "" }),
}));
vi.mock("@/hooks/use-oauth-providers", () => ({
  useOAuthProviders: () => ({ data: [], isLoading: false }),
  useDisconnectOAuth: () => ({}),
}));
vi.mock("@/hooks/use-moa-config", () => ({ useMoaConfig: () => ({}) }));

function ProviderSettingsLink() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/models#provider-kimi-for-coding")}>
      去设置 Kimi
    </button>
  );
}

function renderDesktopRoutes() {
  render(
    <HashRouter>
      <ConfirmProvider>
        <ModelOnboardingDialog />
        <ProviderSettingsLink />
        <Routes>
          <Route path="/" element={<div>工作台</div>} />
          <Route path="/models" element={<ModelsSection />} />
        </Routes>
      </ConfirmProvider>
    </HashRouter>,
  );
}

async function expectSelectedProvider(providerId: string) {
  const provider = BUILTIN_PROVIDER_CATALOG.providers.find((entry) => entry.id === providerId)!;
  await waitFor(() => {
    expect(document.getElementById(`provider-${providerId}`)?.getAttribute("data-active")).toBe("true");
    expect(screen.getByLabelText(provider.apiKeyLabel)).toBeTruthy();
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(provider.baseUrl);
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/index.html#/");
  window.sessionStorage.clear();
  modelInfo.model = "";
  modelInfo.provider = "";
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("桌面模型页的 HashRouter 深链", () => {
  it("首次配置模型选中 DeepSeek，并显示其密钥字段和官方地址", async () => {
    renderDesktopRoutes();
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));
    await expectSelectedProvider("deepseek");
    expect(screen.queryByLabelText("COMPSHARE_API_KEY")).toBeNull();
  });

  it("读取直接深链，并在模型页未卸载时响应去设置的供应商变化", async () => {
    window.history.replaceState(null, "", "/index.html#/models#provider-deepseek");
    renderDesktopRoutes();
    await expectSelectedProvider("deepseek");
    fireEvent.click(screen.getByRole("button", { name: "去设置 Kimi" }));
    await expectSelectedProvider("kimi-for-coding");
    expect(document.getElementById("provider-deepseek")?.getAttribute("data-active")).toBe("false");
  });

  it("没有深链时仍选中用户当前配置的供应商", async () => {
    modelInfo.provider = "cp.compshare.cn";
    modelInfo.model = "test-model";
    window.history.replaceState(null, "", "/index.html#/models");
    renderDesktopRoutes();
    await expectSelectedProvider("cp.compshare.cn");
  });
});
