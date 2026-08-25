// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubRadixGlobals } from "@/test-utils/radix";
import { McpAddDialog } from "./mcp-add-dialog";
import { McpDeleteDialog } from "./mcp-delete-dialog";
import { McpInstallDialog } from "./mcp-install-dialog";

const addMutate = vi.hoisted(() => vi.fn());
const removeMutate = vi.hoisted(() => vi.fn());
const installMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-mcp", () => ({
  useAddMcpServer: () => ({ mutate: addMutate, isPending: false }),
  useRemoveMcpServer: () => ({ mutate: removeMutate, isPending: false }),
  useInstallCatalogEntry: () => ({ mutate: installMutate, isPending: false }),
}));

stubRadixGlobals();
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpAddDialog", () => {
  it("validates and submits a new HTTP server", () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<McpAddDialog existingNames={["filesystem"]} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));
    // name is empty → no mutation
    expect(addMutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("例如 filesystem"), { target: { value: "github" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/mcp"), { target: { value: "https://api.github.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /添加/ }));
    expect(addMutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: "github", url: "https://api.github.com/mcp" }),
    );
  });
});

describe("McpDeleteDialog", () => {
  it("confirms deletion of the named server", () => {
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render(<McpDeleteDialog name="filesystem" onClose={onClose} onDeleted={onDeleted} />);
    expect(screen.getByText(/将从配置中移除服务/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /确认删除/ }));
    expect(removeMutate.mock.calls[0][0]).toBe("filesystem");
  });
});

describe("McpInstallDialog", () => {
  it("requires env values and installs the catalog entry", () => {
    const onInstalled = vi.fn();
    const onClose = vi.fn();
    render(
      <McpInstallDialog
        entry={{
          name: "github",
          description: "GitHub",
          source: "official",
          transport: "http",
          auth_type: "token",
          required_env: [{ name: "GITHUB_TOKEN", prompt: "GitHub Token", required: true }],
          args: [],
          bootstrap: [],
          installed: false,
          enabled: false,
          post_install: "",
          needs_install: true,
        }}
        onClose={onClose}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /安装/ }));
    expect(installMutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("GITHUB_TOKEN"), { target: { value: "ghp_x" } });
    fireEvent.click(screen.getByRole("button", { name: /安装/ }));
    expect(installMutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: "github", env: { GITHUB_TOKEN: "ghp_x" }, enable: true }),
    );
  });
});
