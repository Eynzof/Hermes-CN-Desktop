import { describe, expect, it } from "vitest";
import { buildReviewFlatList, buildReviewTree } from "./review-tree";
import type { ReviewFile } from "./runtime";

function file(path: string, added = 1, removed = 0, overrides: Partial<ReviewFile> = {}): ReviewFile {
  return { path, added, removed, status: "M", staged: false, ...overrides };
}

describe("buildReviewFlatList", () => {
  it("emits one row per file, sorted by path, with a dimmed parent dir", () => {
    const nodes = buildReviewFlatList([file("src/b.ts"), file("a.ts"), file("src/lib/c.ts")]);
    expect(nodes.map((n) => n.id)).toEqual(["a.ts", "src/b.ts", "src/lib/c.ts"]);
    expect(nodes.map((n) => n.name)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(nodes[1].dir).toBe("src");
    expect(nodes[2].dir).toBe("src/lib");
    expect(nodes.every((n) => !n.isDir)).toBe(true);
  });
});

describe("buildReviewTree", () => {
  it("nests files under folders and aggregates churn upward", () => {
    const tree = buildReviewTree(
      [file("src/a.ts", 2, 1), file("src/b.ts", 3, 0), file("README.md", 1, 1)],
      false,
    );
    // Dirs sort before files at each level.
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].name).toBe("src");
    // src aggregates both children: +5 / -1.
    expect(tree[0].added).toBe(5);
    expect(tree[0].removed).toBe(1);
    expect(tree[0].children?.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);

    const readme = tree.find((n) => n.name === "README.md");
    expect(readme?.isDir).toBe(false);
  });

  it("compacts single-child directory chains into one row", () => {
    const tree = buildReviewTree([file("a/b/c/deep.ts")], true);
    expect(tree).toHaveLength(1);
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].name).toBe("a/b/c");
    expect(tree[0].children?.[0].name).toBe("deep.ts");
  });

  it("does not compact when a directory has multiple children", () => {
    const tree = buildReviewTree([file("a/b/one.ts"), file("a/c/two.ts")], true);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children?.map((c) => c.name).sort()).toEqual(["b", "c"]);
  });
});
