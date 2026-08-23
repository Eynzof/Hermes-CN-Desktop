import { describe, expect, it } from "vitest";
import { exportProfile, scrubSecret } from "./export";

describe("exportProfile", () => {
  it("resolves to the tar.gz path for the given destination and name", async () => {
    await expect(exportProfile("C:\\hermes", "work", "C:\\out")).resolves.toBe("C:\\out\\work.tar.gz");
  });

  it("handles destinations without a trailing separator", async () => {
    await expect(exportProfile("~/.hermes", "research", "C:\\exports")).resolves.toBe("C:\\exports\\research.tar.gz");
  });

  it("preserves extraFiles in the call contract (stub ignores them)", async () => {
    const result = await exportProfile("~/.hermes", "work", "C:\\tmp\\out", {
      extraFiles: { "desktop.json": "{\"window\":{}}" },
    });
    expect(result).toBe("C:\\tmp\\out\\work.tar.gz");
  });

  it("returns a promise (async stub for the Rust command)", () => {
    const promise = exportProfile("~/.hermes", "p", "/tmp");
    expect(promise).toBeInstanceOf(Promise);
  });
});

describe("scrubSecret", () => {
  it("redacts api_key assignments", () => {
    expect(scrubSecret("api_key=sk-1234567890")).toBe("api_key: ***");
    expect(scrubSecret("API_KEY = sk-abc")).toBe("API_KEY: ***");
    expect(scrubSecret("api-key: sk-abc")).toBe("api-key: ***");
    expect(scrubSecret("apikey: sk-abc")).toBe("apikey: ***");
  });

  it("redacts token and secret assignments", () => {
    expect(scrubSecret("token: abc123")).toBe("token: ***");
    expect(scrubSecret("TOKEN = 12345")).toBe("TOKEN: ***");
    expect(scrubSecret("secret= hunter2")).toBe("secret: ***");
  });

  it("redacts every secret in a multi-line document", () => {
    const input = "api_key=one\ntoken: two\napi_key = three";
    const output = scrubSecret(input);
    expect(output).not.toContain("one");
    expect(output).not.toContain("two");
    expect(output).not.toContain("three");
    expect(output.match(/:\s+\*\*\*/g)).toHaveLength(3);
  });

  it("leaves non-secret lines untouched", () => {
    const input = "model: claude\nprovider: openrouter\npassword: not-a-secret-key";
    expect(scrubSecret(input)).toBe(input);
  });

  it("leaves secret-shaped words without an assignment untouched", () => {
    expect(scrubSecret("the token was rotated")).toBe("the token was rotated");
    expect(scrubSecret("api_key")).toBe("api_key");
  });

  it("handles empty strings", () => {
    expect(scrubSecret("")).toBe("");
  });
});
