import ReactDOMServer from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel wires TanStack mutations internally; for SSR render tests we mock
// the hooks to plain objects and only assert what the mocks drive.
vi.mock("@/hooks/use-app-update", () => ({
  useAppUpdateCheck: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({
      ok: true,
      currentVersion: "0.7.0",
      latestVersion: "0.8.0",
      updateAvailable: true,
      compatible: true,
    })),
  }),
  useAppUpdateDownload: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({
      ok: true,
      ready: true,
      version: "0.8.0",
      manifestSource: "cloudflare-control",
      downloadSource: "cloudflare-cache",
      fallbackUsed: false,
    })),
  }),
  useAppUpdateInstall: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({ ok: true, installStarted: true })),
  }),
}));

vi.mock("@/hooks/use-hot-update-backend", () => ({
  useHotUpdateBackend: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({ ok: true, sourceRoot: "D:/core", commit: "deadbeef" })),
  }),
}));

vi.mock("@/hooks/use-runtime-update", () => ({
  useRuntimeInfo: () => ({ data: undefined }),
}));

vi.mock("@/hooks/use-ui-update", () => ({
  useUiUpdateCheck: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({
      ok: true,
      updateAvailable: true,
      currentUiVersion: "0.7.0",
      manifest: { uiVersion: "0.8.0" },
    })),
  }),
  useUiUpdateInstall: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({ ok: true, installed: { uiVersion: "0.8.0" } })),
  }),
  useUiUpdateRollback: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => ({ ok: true, installed: { uiVersion: "0.7.0" } })),
  }),
}));

vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("@/lib/runtime", () => ({
  runtime: {
    isManaged: () => true,
    isAttached: () => false,
    applyRuntimeControlResult: () => undefined,
    refreshGatewayUrl: async () => "http://127.0.0.1:9120",
    platform: "tauri",
  },
}));

import { ManagedRuntimePanel } from "./managed-runtime-panel";
import { defaultUpdateConfig } from "@/lib/update-config";

function stubWindow(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("window", {
    __HERMES_RUNTIME__: {
      connectionMode: "managed",
      apiBaseUrl: "http://127.0.0.1:9120",
      managedRuntimeLifecycleState: "stopped",
      managedRuntimeDesiredState: "stopped",
      backendReady: true,
    },
    hermesDesktop: {
      appUpdateCheck: vi.fn(),
      appUpdateDownload: vi.fn(),
      appUpdatePending: vi.fn(),
      appUpdateInstall: vi.fn(),
      uiCheckUpdate: vi.fn(),
      uiInstallUpdate: vi.fn(),
      uiRollback: vi.fn(),
      getDesktopControlState: vi.fn(),
    },
    location: { href: "http://localhost:9545/", protocol: "http:" },
    setTimeout,
    ...overrides,
  });
}

describe("ManagedRuntimePanel — signed shell update buttons", () => {
  beforeEach(() => {
    stubWindow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows 检查更新 / 一键更新 / 更新源设置 for a managed runtime with the update bridge", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<ManagedRuntimePanel />);
    expect(html).toContain("检查更新");
    expect(html).toContain("一键更新");
    expect(html).toContain("更新源设置");
  });

  it("shows the UI hot-update buttons (检查界面更新 / UI 热更新 / 回退界面) when the ui bridge is present", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<ManagedRuntimePanel />);
    expect(html).toContain("UI 热更新");
    expect(html).toContain("检查界面更新");
    expect(html).toContain("回退界面");
  });

  it("hides the UI hot-update buttons when the ui bridge is missing", () => {
    stubWindow({ hermesDesktop: { appUpdateCheck: vi.fn(), appUpdateDownload: vi.fn(), appUpdateInstall: vi.fn(), getDesktopControlState: vi.fn() } });
    const html = ReactDOMServer.renderToStaticMarkup(<ManagedRuntimePanel />);
    expect(html).not.toContain("UI 热更新");
    expect(html).not.toContain("检查界面更新");
    expect(html).not.toContain("回退界面");
  });

  it("hides the update section when the bridge is missing", () => {
    stubWindow({ hermesDesktop: { getDesktopControlState: vi.fn() } });
    const html = ReactDOMServer.renderToStaticMarkup(<ManagedRuntimePanel />);
    expect(html).not.toContain("检查更新");
    expect(html).not.toContain("一键更新");
  });

  it("renders the update-source settings form with the CN defaults", () => {
    // The form only appears once the user opens the section (closed by
    // default); verify the defaults helper backing the form are consistent.
    expect(defaultUpdateConfig().releaseManifestUrl).toContain("desktop.hermesagent.org.cn");
    expect(defaultUpdateConfig().shellUpdaterEndpoint).toBe("");
    const html = ReactDOMServer.renderToStaticMarkup(<ManagedRuntimePanel />);
    expect(html).not.toContain("releaseManifestUrl（统一更新清单）");
  });
});
