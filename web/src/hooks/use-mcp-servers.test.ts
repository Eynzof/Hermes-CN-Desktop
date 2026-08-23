import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "@/lib/transport";
import { fetchMcpServersSummary } from "./use-mcp-servers";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
}));

const mockFetchJSON = fetchJSON as unknown as ReturnType<typeof vi.fn>;

describe("fetchMcpServersSummary", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("通过官方 MCP 接口汇总服务数量和启用状态", async () => {
    mockFetchJSON.mockResolvedValue({
      servers: [
        {
          name: "chrome-devtools",
          transport: "stdio",
          command: "npx",
          args: [],
          env: {},
          enabled: true,
        },
        {
          name: "linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          args: [],
          env: {},
          enabled: false,
        },
      ],
    });

    const result = await fetchMcpServersSummary();

    expect(mockFetchJSON).toHaveBeenCalledOnce();
    expect(mockFetchJSON.mock.calls[0]?.[0]).toBe("/api/mcp/servers");
    expect(result).toEqual({
      summary: { total: 2, enabled: 1 },
      servers: [
        { name: "chrome-devtools", enabled: true },
        { name: "linear", enabled: false },
      ],
    });
  });

  it("保留调用方的中止信号", async () => {
    mockFetchJSON.mockResolvedValue({ servers: [] });
    const controller = new AbortController();

    await fetchMcpServersSummary(controller.signal);

    expect(mockFetchJSON.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });
});
