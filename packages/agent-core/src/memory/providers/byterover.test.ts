import { describe, expect, it } from "vitest";
import { ByteRoverProvider, createByteRoverProvider } from "./byterover.js";

type RunCommand = (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function okCommand(stdout: string): RunCommand {
  return async () => ({ stdout, stderr: "", exitCode: 0 });
}

describe("ByteRoverProvider.search", () => {
  it("runs `brv query` with -C workingDir and --top-k", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      workingDir: "/home/hermes/byterover",
      runCommand: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ results: [{ id: "b1", content: "match", score: 0.8 }] }),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await provider.search("hello", { top_k: 5 });

    expect(calls).toEqual([["-C", "/home/hermes/byterover", "query", "hello", "--top-k", "5"]]);
    expect(result.entries).toEqual([{ id: "b1", content: "match", score: 0.8 }]);
  });

  it("defaults top_k to 5", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      workingDir: "/wd",
      runCommand: async (args) => {
        calls.push(args);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });

    await provider.search("q");

    expect(calls[0]?.slice(-4)).toEqual(["query", "q", "--top-k", "5"]);
  });

  it("omits -C when no workingDir is configured", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      runCommand: async (args) => {
        calls.push(args);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });

    await provider.search("q");

    expect(calls[0]).toEqual(["query", "q", "--top-k", "5"]);
  });

  it("returns empty entries when results is missing", async () => {
    const provider = new ByteRoverProvider({ runCommand: okCommand("{}") });
    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("falls back to a status payload when stdout is not JSON", async () => {
    const provider = new ByteRoverProvider({ runCommand: okCommand("plain output") });
    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("rejects when the command exits non-zero", async () => {
    const provider = new ByteRoverProvider({
      runCommand: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
    });

    await expect(provider.search("q")).rejects.toThrow("brv failed (1): boom");
  });

  it("fails gracefully with the default command runner (no seam injected)", async () => {
    const provider = new ByteRoverProvider({ workingDir: "/wd" });
    await expect(provider.search("q")).rejects.toThrow(/brv is not installed/);
  });
});

describe("ByteRoverProvider.add", () => {
  it("runs `brv curate --add` with optional tags", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      workingDir: "/wd",
      runCommand: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ id: "b2", status: "added" }), stderr: "", exitCode: 0 };
      },
    });

    const result = await provider.add("note", { tags: "work" });

    expect(calls).toEqual([["-C", "/wd", "curate", "--add", "note", "--tags", "work"]]);
    expect(result).toEqual({ success: true, message: "added", id: "b2" });
  });

  it("omits --tags when no tags option is given", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      runCommand: async (args) => {
        calls.push(args);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });

    const result = await provider.add("note");

    expect(calls[0]).toEqual(["curate", "--add", "note"]);
    expect(result).toEqual({ success: true, message: "ByteRover memory curated.", id: undefined });
  });
});

describe("ByteRoverProvider.delete", () => {
  it("runs `brv curate --remove` with the id", async () => {
    const calls: string[][] = [];
    const provider = new ByteRoverProvider({
      workingDir: "/wd",
      runCommand: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ status: "removed" }), stderr: "", exitCode: 0 };
      },
    });

    const result = await provider.delete("b1");

    expect(calls).toEqual([["-C", "/wd", "curate", "--remove", "b1"]]);
    expect(result).toEqual({ success: true, message: "removed", id: "b1" });
  });

  it("uses the default message when status is absent", async () => {
    const provider = new ByteRoverProvider({ runCommand: okCommand("{}") });
    await expect(provider.delete("b1")).resolves.toEqual({
      success: true,
      message: "ByteRover memory removed.",
      id: "b1",
    });
  });
});

describe("ByteRoverProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new ByteRoverProvider();
    expect(provider.name).toBe("byterover");
    expect(provider.displayName).toBe("ByteRover");
  });

  it("declares workingDir/apiKey fields in the config schema", () => {
    const schema = new ByteRoverProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["workingDir", "text", true],
      ["apiKey", "secret", undefined],
    ]);
  });

  it("validates workingDir as required", () => {
    const provider = new ByteRoverProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["workingDir is required"]);
    expect(provider.validateConfig({ workingDir: "/wd" }).valid).toBe(true);
    expect(provider.validateConfig({ workingDir: "" }).valid).toBe(false);
  });

  it("factory passes through runCommand and drops non-string values", async () => {
    let captured: string[][] = [];
    const provider = createByteRoverProvider({
      workingDir: 42,
      apiKey: null,
      runCommand: async (args: string[]) => {
        captured.push(args);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });

    expect(provider).toBeInstanceOf(ByteRoverProvider);
    await provider.search("q");
    // workingDir was dropped (non-string) so no -C prefix is expected.
    expect(captured).toEqual([["query", "q", "--top-k", "5"]]);
  });
});
