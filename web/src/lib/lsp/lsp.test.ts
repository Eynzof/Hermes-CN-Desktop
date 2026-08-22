import { describe, it, expect } from "vitest";
import { encodeJsonRpc, decodeJsonRpcFrames } from "./protocol.js";
import { MockProcessTransport } from "./process-transport.js";
import { LspClient } from "./client.js";
import { resolveServerIdForFile, LSP_SERVERS } from "./servers.js";
import { LspService } from "./manager.js";
import { reportDiagnostics } from "./reporter.js";
import { buildLineShift } from "./range-shift.js";
import { loadLspConfig } from "./config.js";

describe("lsp protocol", () => {
  it("encodes and decodes JSON-RPC", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const encoded = encodeJsonRpc(msg);
    const { messages } = decodeJsonRpcFrames(encoded);
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).method).toBe("initialize");
  });
});

describe("lsp client", () => {
  it("receives diagnostics", async () => {
    const transport = new MockProcessTransport();
    const client = new LspClient({ transport });
    await transport.start();
    await client.openFile("file:///project/a.py", "python", 1, "x");
    transport.push(
      encodeJsonRpc({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///project/a.py", diagnostics: [{ severity: 1, message: "err", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] },
      })
    );
    await client.pump();
    expect(client.getDiagnostics("file:///project/a.py")).toHaveLength(1);
  });
});

describe("lsp servers", () => {
  it("resolves python to pyright", () => {
    expect(resolveServerIdForFile("foo.py")).toBe("pyright");
  });

  it("has server definitions", () => {
    expect(LSP_SERVERS.length).toBeGreaterThan(0);
  });
});

describe("lsp manager", () => {
  it("produces keys and tracks broken servers", () => {
    const service = new LspService({
      createClient: async () => {
        const transport = new MockProcessTransport();
        const client = new LspClient({ transport });
        return { client, transport };
      },
    });
    expect(service.key("pyright", "file:///p")).toBe("pyright::file:///p");
    service.markBroken("pyright", "file:///p");
    expect(() => service.getDiagnosticsSync("file:///p/a.py", "pyright", "file:///p", "x")).rejects.toThrow();
  });
});

describe("lsp reporter", () => {
  it("formats diagnostics", () => {
    const block = reportDiagnostics(
      [{ severity: 1, message: "bad", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      "a.py"
    );
    expect(block).toContain("ERROR");
    expect(block).toContain("a.py");
  });
});

describe("lsp range shift", () => {
  it("returns a shift", () => {
    expect(buildLineShift("a\nb", "a\nb\nc")).toEqual([{ oldLine: 0, newLine: 0, delta: 1 }]);
  });
});

describe("lsp config", () => {
  it("loads defaults", () => {
    const cfg = loadLspConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.waitMode).toBe("document");
  });
});
