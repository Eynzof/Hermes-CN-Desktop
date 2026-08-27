// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { McpCatalogEntry, McpServer, McpTestResult } from "@hermes/protocol";
import { McpServerCard } from "./mcp-server-card";
import { McpCatalogCard } from "./mcp-catalog-card";
import { McpDialogShell } from "./mcp-dialog-shell";

afterEach(() => cleanup());

const server: McpServer = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { API_KEY: "sk-***" },
  enabled: true,
};

const catalogEntry: McpCatalogEntry = {
  name: "github",
  description: "GitHub MCP server",
  source: "official",
  transport: "http",
  auth_type: "token",
  url: "https://api.github.com/mcp",
  required_env: [],
  args: [],
  bootstrap: [],
  installed: false,
  enabled: false,
  post_install: "",
  needs_install: true,
};

describe("McpServerCard", () => {
  it("toggles enable, tests connection and requests deletion", () => {
    const onToggle = vi.fn();
    const onTest = vi.fn();
    const onDelete = vi.fn();
    render(<McpServerCard server={server} testing={false} toggling={false} onTest={onTest} onToggle={onToggle} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /禁用/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(onTest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows disabled label and test results", () => {
    const result: McpTestResult = { ok: true, tools: [{ name: "read_file", description: "read" }] };
    render(
      <McpServerCard
        server={{ ...server, enabled: false }}
        result={result}
        testing={false}
        toggling={false}
        onTest={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("已禁用")).toBeTruthy();
    expect(screen.getByText(/工具（1）：/)).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
  });
});

describe("McpCatalogCard", () => {
  it("installs from the catalog and shows installed state", () => {
    const onInstall = vi.fn();
    const { rerender } = render(
      <McpCatalogCard entry={catalogEntry} diagnostics={[]} installing={false} onInstall={onInstall} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /安装/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
    rerender(
      <McpCatalogCard
        entry={{ ...catalogEntry, installed: true }}
        diagnostics={[]}
        installing={false}
        onInstall={onInstall}
      />,
    );
    expect(screen.queryByRole("button", { name: /安装/ })).toBeNull();
    expect(screen.getAllByText("已安装").length).toBeGreaterThan(0);
  });
});

describe("McpDialogShell", () => {
  it("closes via the X button unless busy", () => {
    const onClose = vi.fn();
    render(
      <McpDialogShell open title="添加服务" onClose={onClose}>
        <p>内容</p>
      </McpDialogShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks the close button while busy", () => {
    const onClose = vi.fn();
    render(
      <McpDialogShell open title="添加服务" busy onClose={onClose}>
        <p>内容</p>
      </McpDialogShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
