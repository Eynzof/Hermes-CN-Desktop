import { describe, expect, it } from "vitest";
import { pickSubProvider, rankSubProviders, type SubProviderCandidate } from "./routing.js";

const candidates: SubProviderCandidate[] = [
  { id: "a", price: 5, throughput: 10, latencyMs: 200, parameters: { vision: true } },
  { id: "b", price: 2, throughput: 8, latencyMs: 400, parameters: { vision: false } },
  { id: "c", price: 1, throughput: 6, latencyMs: 100, parameters: { vision: true } },
];

describe("provider routing controls (P1-9)", () => {
  it("sorts by price ascending when sortBy=price", () => {
    const ranked = rankSubProviders({ sortBy: "price" }, candidates);
    expect(ranked.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by throughput descending when sortBy=throughput", () => {
    const ranked = rankSubProviders({ sortBy: "throughput" }, candidates);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by latency ascending when sortBy=latency", () => {
    const ranked = rankSubProviders({ sortBy: "latency" }, candidates);
    expect(ranked.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("applies blacklist before sorting", () => {
    const ranked = rankSubProviders({ sortBy: "price", blacklist: ["b"] }, candidates);
    expect(ranked.map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("applies whitelistOnly restriction", () => {
    const ranked = rankSubProviders(
      { sortBy: "price", whitelistOnly: true, whitelist: ["a", "b"] },
      candidates,
    );
    expect(ranked.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("requires parameters to match", () => {
    const ranked = rankSubProviders(
      { requireParameters: { vision: true } },
      candidates,
    );
    expect(ranked.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("honors explicit priority when sorting by priority", () => {
    const withPriority: SubProviderCandidate[] = [
      { id: "low", priority: 1 },
      { id: "high", priority: 10 },
      { id: "none" },
    ];
    const ranked = rankSubProviders({ sortBy: "priority", defaultPriority: 5 }, withPriority);
    expect(ranked[0].id).toBe("high");
    expect(ranked[1].id).toBe("none"); // defaultPriority 5 beats low 1
    expect(ranked[2].id).toBe("low");
  });

  it("pickSubProvider returns the best eligible candidate", () => {
    expect(pickSubProvider({ sortBy: "price" }, candidates)?.id).toBe("c");
    expect(pickSubProvider({ sortBy: "price", whitelist: ["a"], whitelistOnly: true }, candidates)?.id).toBe("a");
    expect(pickSubProvider({ sortBy: "price", blacklist: ["a", "b", "c"] }, candidates)).toBeUndefined();
  });

  it("does not mutate the input array", () => {
    const copy = [...candidates];
    rankSubProviders({ sortBy: "price" }, candidates);
    expect(candidates).toEqual(copy);
  });
});
