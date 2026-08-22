import { describe, expect, it } from "vitest";
import { resolveSttProvider } from "./stt";

describe("resolveSttProvider", () => {
  it("resolves configured provider", () => {
    const providers = [
      { id: "local", transcribe: async () => ({ transcript: "", provider: "local" }) },
      { id: "groq", transcribe: async () => ({ transcript: "", provider: "groq" }) },
    ];
    expect(resolveSttProvider(providers, { provider: "groq" })?.id).toBe("groq");
  });

  it("falls back to local", () => {
    const providers = [
      { id: "local", transcribe: async () => ({ transcript: "", provider: "local" }) },
    ];
    expect(resolveSttProvider(providers)?.id).toBe("local");
  });

  it("falls back to first provider when local missing", () => {
    const providers = [{ id: "openai", transcribe: async () => ({ transcript: "", provider: "openai" }) }];
    expect(resolveSttProvider(providers)?.id).toBe("openai");
  });
});
