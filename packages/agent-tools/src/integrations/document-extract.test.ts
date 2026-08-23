import { describe, expect, it } from "vitest";
import "./document-extract.js";
import { registry } from "../registry.js";

describe("document_extract catalog registration", () => {
  it("registers the document_extract tool", () => {
    const entry = registry.get("document_extract");
    expect(entry).toBeDefined();
    expect(entry!.toolset).toBe("document_extract");
    expect(entry!.handler).toBeTypeOf("function");
  });

  it("lists path and maxBytes as required (objectSchema defaults to all keys)", () => {
    const schema = registry.get("document_extract")!.schema;
    expect(schema.required).toEqual(["path", "maxBytes"]);
    expect(schema.properties).toHaveProperty("maxBytes");
  });
});

describe("document_extract tool dispatch", () => {
  it("returns the stub extraction message for a path", async () => {
    const res = await registry.dispatch("document_extract", { path: "/tmp/report.docx" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Would extract text from /tmp/report.docx");
  });

  it("handles missing args without crashing", async () => {
    const res = await registry.dispatch("document_extract", undefined, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Would extract text from undefined");
  });
});
