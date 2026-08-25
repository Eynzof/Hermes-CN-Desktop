// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MemoryProviderConfigResponse, MemoryProviderRuntimeStatusResponse } from "@hermes/protocol";
import { MemoryProviderConfig } from "./memory-provider-config";
import { MemoryProviderStatus } from "./memory-provider-status";

afterEach(() => cleanup());

const provider = "openviking" as const;
const config = {
  provider: "openviking",
  fields: [
    { key: "url", value: "http://localhost:18400", kind: "string", description: "端点", required: true, advanced: false },
    { key: "token", value: "", kind: "secret", description: "密钥", required: false, advanced: false },
  ],
  setup: {
    pip_dependencies: [],
    external_dependencies: [],
    required_env: [],
    dependencies_installed: true,
  },
} as unknown as MemoryProviderConfigResponse;

describe("MemoryProviderConfig", () => {
  it("saves edited values via 保存并检测", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <MemoryProviderConfig
        provider={provider}
        config={config}
        loading={false}
        saving={false}
        setupPending={false}
        onSave={onSave}
        onSetup={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("http://localhost:18400"), {
      target: { value: "http://localhost:18500" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存并检测/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ url: "http://localhost:18500" }));
  });

  it("shows 安装依赖 and triggers setup when dependencies are missing", () => {
    const onSetup = vi.fn(async () => {});
    render(
      <MemoryProviderConfig
        provider={provider}
        config={{ ...config, setup: { pip_dependencies: [], external_dependencies: [], required_env: [], dependencies_installed: false } }}
        loading={false}
        saving={false}
        setupPending={false}
        onSave={vi.fn()}
        onSetup={onSetup}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /安装依赖/ }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryProviderStatus", () => {
  const status = {
    provider: "openviking",
    active: false,
    configured: true,
    reachable: true,
    healthy: true,
    endpoint: "http://localhost:18400",
    version: "1.0",
    console_url: null,
    checked_at: "1700000000",
    error: null,
    details: null,
    bank: { count: "3", size: "1024" },
  } as unknown as MemoryProviderRuntimeStatusResponse;

  it("refreshes via 刷新状态", () => {
    const onRefresh = vi.fn();
    render(
      <MemoryProviderStatus provider={provider} status={status} loading={false} refreshing={false} onRefresh={onRefresh} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /刷新状态/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
