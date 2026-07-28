import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryConsoleDialog, resolveMemoryConsoleUrl } from "./memory-console-dialog";

describe("MemoryConsoleDialog", () => {
  it("uses the provider console defaults when runtime status has no URL", () => {
    expect(resolveMemoryConsoleUrl("openviking")).toBe("http://127.0.0.1:1933/studio");
    expect(resolveMemoryConsoleUrl("hindsight")).toBe("http://localhost:9999/dashboard");
  });

  it("prefers the current runtime console URL", () => {
    expect(resolveMemoryConsoleUrl("hindsight", " https://memory.example.test/console "))
      .toBe("https://memory.example.test/console");
  });

  it("renders provider-specific console labels", () => {
    const openViking = ReactDOMServer.renderToStaticMarkup(<MemoryConsoleDialog provider="openviking" />);
    const hindsight = ReactDOMServer.renderToStaticMarkup(<MemoryConsoleDialog provider="hindsight" />);

    expect(openViking).toContain("OpenViking 控制台");
    expect(hindsight).toContain("Hindsight 控制台");
    expect(openViking).not.toContain("深度控制台");
  });
});
