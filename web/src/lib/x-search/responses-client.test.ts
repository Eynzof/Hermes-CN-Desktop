import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "@/lib/web-search/http.js";
import { postXSearch } from "./responses-client.js";
import type { XaiCredentials } from "./credentials.js";

function mockRequest(result: Partial<http.WebRequestResult>) {
  return vi.spyOn(http, "webRequest").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: "",
    ...result,
  });
}

describe("x_search responses client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct URL, headers and payload", async () => {
    const spy = mockRequest({
      body: JSON.stringify({ output: [{ content: [{ text: "hi" }] }] }),
    });
    const creds: XaiCredentials = { bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" };
    await postXSearch(
      { query: "hello", allowed_x_handles: ["elonmusk"], from_date: "2024-01-01" },
      creds,
      { model: "grok-4.5" },
    );
    expect(spy).toHaveBeenCalledOnce();
    const input = spy.mock.calls[0][0];
    expect(input.url).toBe("https://api.x.ai/v1/responses");
    expect(input.headers?.Authorization).toBe("Bearer key");
    const body = JSON.parse(input.body!);
    expect(body.model).toBe("grok-4.5");
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["elonmusk"], from_date: "2024-01-01" }]);
  });

  it("retries on 5xx then fails", async () => {
    const spy = vi.spyOn(http, "webRequest").mockRejectedValue(new Error("network"));
    const creds: XaiCredentials = { bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" };
    await expect(postXSearch({ query: "q" }, creds, { retries: 1 })).rejects.toThrow("network");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("fails fast on 4xx and surfaces code:", async () => {
    mockRequest({ ok: false, status: 403, body: JSON.stringify({ error: { message: "Forbidden", code: "forbidden" } }) });
    const creds: XaiCredentials = { bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" };
    await expect(postXSearch({ query: "q" }, creds, {})).rejects.toThrow(/code: forbidden/);
  });

  it("includes reasoning effort when configured", async () => {
    const spy = mockRequest({ body: JSON.stringify({ output: [] }) });
    const creds: XaiCredentials = { bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" };
    await postXSearch({ query: "q" }, creds, { reasoning_effort: "high" });
    const body = JSON.parse(spy.mock.calls[0][0].body!);
    expect(body.reasoning).toEqual({ effort: "high" });
  });
});