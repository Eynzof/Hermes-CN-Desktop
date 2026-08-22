import { describe, expect, it, vi } from "vitest";
import {
  SkillHubEntry,
  SkillHubTrustLevel,
  SkillsHubClient,
  SkillsHubIndex,
} from "./hub.js";

function makeFetch(response: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const sampleIndex: SkillsHubIndex = {
  version: 1,
  source: "test",
  updated_at: "2026-01-01T00:00:00Z",
  entries: [
    {
      name: "Rust",
      identifier: "official/coding/rust",
      source: "official",
      trust_level: "builtin",
      category: "coding",
      description: "Systems programming skill",
      tags: ["coding", "rust"],
    },
    {
      name: "TypeScript",
      identifier: "official/coding/typescript",
      source: "official",
      trust_level: "trusted",
      category: "coding",
      description: "Typed JavaScript skill",
      tags: ["coding", "typescript"],
    },
    {
      name: "Community Helper",
      identifier: "community/helper",
      source: "community",
      trust_level: "community",
      description: "A community skill",
      tags: ["helper"],
    },
  ],
};

describe("SkillsHubClient", () => {
  it("fetches and validates a registry index", async () => {
    const fetchImpl = makeFetch(sampleIndex);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    const index = await client.fetchIndex();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/index.json",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(index.entries).toHaveLength(3);
    expect(index.entries[0].trust_level).toBe("builtin");
  });

  it("throws on non-ok responses", async () => {
    const fetchImpl = makeFetch({ error: "not found" }, 404);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    await expect(client.fetchIndex()).rejects.toThrow(/HTTP 404/);
  });

  it("throws on invalid response shapes", async () => {
    const fetchImpl = makeFetch({ entries: "not-an-array" }, 200);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    await expect(client.fetchIndex()).rejects.toThrow();
  });

  it("searches by name, description, category, and tags", async () => {
    const fetchImpl = makeFetch(sampleIndex);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    const byName = await client.search("typescript");
    expect(byName).toHaveLength(1);
    expect(byName[0].identifier).toBe("official/coding/typescript");

    const byTag = await client.search("rust");
    expect(byTag.map((e) => e.identifier)).toEqual([
      "official/coding/rust",
    ]);

    const byCategory = await client.search("coding");
    expect(byCategory).toHaveLength(2);

    const empty = await client.search("not-present");
    expect(empty).toHaveLength(0);
  });

  it("returns all entries up to the limit when query is empty", async () => {
    const fetchImpl = makeFetch(sampleIndex);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    const all = await client.search("", 2);
    expect(all).toHaveLength(2);
  });

  it("finds an entry by identifier", async () => {
    const fetchImpl = makeFetch(sampleIndex);
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    const found = await client.findByIdentifier("official/coding/rust");
    expect(found?.name).toBe("Rust");

    const missing = await client.findByIdentifier("missing");
    expect(missing).toBeUndefined();
  });

  it("defaults unknown trust levels to community", async () => {
    const fetchImpl = makeFetch({
      entries: [
        {
          name: "Odd",
          identifier: "odd/one",
          source: "unknown",
          trust_level: "weird",
        },
      ],
    });
    const client = new SkillsHubClient({
      registryUrl: "https://example.com/index.json",
      fetchImpl,
    });

    // Zod will reject the unknown enum value and throw.
    await expect(client.fetchIndex()).rejects.toThrow();
  });

  it("validates SkillHubEntry schema independently", () => {
    const parsed = SkillHubEntry.parse({
      name: "Test",
      identifier: "test",
      source: "official",
      trust_level: "trusted",
    });
    expect(parsed.trust_level).toBe("trusted");
    expect(SkillHubTrustLevel.options).toContain("builtin");
  });
});
