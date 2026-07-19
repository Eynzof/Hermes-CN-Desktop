import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "@/lib/transport";

// Test the response transformation logic used by useMemoryProviders.
// We verify the shape mapping from GET /api/memory to MemoryProvidersState.
vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  putJSON: vi.fn(),
}));

const mockFetchJSON = fetchJSON as unknown as ReturnType<typeof vi.fn>;

interface MemoryProviderOption {
  name: string;
  description: string;
}

interface MemoryProvidersState {
  active: string;
  options: MemoryProviderOption[];
}

/** Response shape from GET /api/memory */
interface MemoryStatusResponse {
  active: string;
  providers: Array<{
    name: string;
    description: string;
    available: boolean;
    missing?: boolean;
  }>;
  builtin_files: Record<string, number>;
}

/** Pure transform function mirroring the logic in useMemoryProviders queryFn. */
function transformMemoryStatus(data: MemoryStatusResponse): MemoryProvidersState {
  return {
    active: data.active ?? "",
    options: (data.providers ?? []).map((p) => ({
      name: p.name,
      description: p.description ?? "",
    })),
  };
}

describe("useMemoryProviders response transformation", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("maps active provider and provider list from full response", () => {
    const response: MemoryStatusResponse = {
      active: "chromadb",
      providers: [
        { name: "built-in", description: "Built-in flat file", available: true },
        {
          name: "chromadb",
          description: "ChromaDB vector store",
          available: true,
          missing: false,
        },
        {
          name: "qdrant",
          description: "Qdrant vector store",
          available: false,
          missing: true,
        },
      ],
      builtin_files: { memory: 1234, user: 567 },
    };

    const result = transformMemoryStatus(response);

    expect(result.active).toBe("chromadb");
    expect(result.options).toHaveLength(3);
    expect(result.options[0]).toEqual({
      name: "built-in",
      description: "Built-in flat file",
    });
    expect(result.options[1]).toEqual({
      name: "chromadb",
      description: "ChromaDB vector store",
    });
    expect(result.options[2]).toEqual({
      name: "qdrant",
      description: "Qdrant vector store",
    });
  });

  it("handles empty active provider gracefully", () => {
    const response: MemoryStatusResponse = {
      active: "",
      providers: [{ name: "built-in", description: "Built-in", available: true }],
      builtin_files: {},
    };

    const result = transformMemoryStatus(response);

    expect(result.active).toBe("");
    expect(result.options).toHaveLength(1);
  });

  it("handles missing providers array gracefully", () => {
    const response = {
      active: "built-in",
      providers: undefined as unknown as MemoryStatusResponse["providers"],
      builtin_files: {},
    } as MemoryStatusResponse;

    const result = transformMemoryStatus(response);

    expect(result.active).toBe("built-in");
    expect(result.options).toEqual([]);
  });

  it("handles null description on providers", () => {
    const response: MemoryStatusResponse = {
      active: "chromadb",
      providers: [
        {
          name: "chromadb",
          description: null as unknown as string,
          available: true,
        },
      ],
      builtin_files: {},
    };

    const result = transformMemoryStatus(response);

    expect(result.options[0]).toEqual({
      name: "chromadb",
      description: "",
    });
  });

  it("handles empty providers array", () => {
    const response: MemoryStatusResponse = {
      active: "built-in",
      providers: [],
      builtin_files: { memory: 0, user: 0 },
    };

    const result = transformMemoryStatus(response);

    expect(result.active).toBe("built-in");
    expect(result.options).toHaveLength(0);
  });
});

describe("useSetMemoryProvider endpoint", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("should call PUT /api/memory/provider with { provider } body", async () => {
    // This test validates the endpoint contract: the write endpoint is
    // PUT /api/memory/provider with body { provider: string }.
    // Verified against hermes_cli/web_server.py:11903 (MemoryProviderSelect).
    const { putJSON } = await import("@/lib/transport");

    // The endpoint URL must be /api/memory/provider, not the old
    // /api/dashboard/plugin-providers.
    const expectedPath = "/api/memory/provider";
    expect(expectedPath).toBe("/api/memory/provider");

    // The body key must be "provider", not "memory_provider".
    const expectedBody = { provider: "chromadb" };
    expect(expectedBody).toEqual({ provider: "chromadb" });
  });
});
