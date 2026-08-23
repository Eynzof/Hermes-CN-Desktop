import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses a complete skill document into frontmatter + body", () => {
    const content = `---
name: sample-skill
description: A sample skill.
version: "1.0.0"
author: Hermes
license: MIT
platforms: [linux, macos, windows]
---

## When to Use

Use this skill when needed.
`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("sample-skill");
    expect(frontmatter.description).toBe("A sample skill.");
    expect(frontmatter.author).toBe("Hermes");
    expect(frontmatter.license).toBe("MIT");
    expect(frontmatter.platforms).toEqual(["linux", "macos", "windows"]);
    expect(body).toBe("\n## When to Use\n\nUse this skill when needed.\n");
  });

  it("parses an inline list into an array of trimmed strings", () => {
    const { frontmatter } = parseFrontmatter(`---
tags: [alpha, beta,  gamma]
---
body
`);
    expect(frontmatter.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses an empty inline list into an empty array", () => {
    const { frontmatter } = parseFrontmatter(`---
tags: []
---
body
`);
    expect(frontmatter.tags).toEqual([]);
  });

  it("parses nested maps (metadata.hermes.tags)", () => {
    const { frontmatter } = parseFrontmatter(`---
name: nested-skill
metadata:
  hermes:
    tags: [sample, nested]
---
body
`);
    expect(frontmatter.metadata).toEqual({ hermes: { tags: ["sample", "nested"] } });
  });

  it("parses a block list under a key with empty value", () => {
    const { frontmatter } = parseFrontmatter(`---
related_skills:
  - skill-one
  - skill-two
---
body
`);
    expect(frontmatter.related_skills).toEqual(["skill-one", "skill-two"]);
  });

  it("parses a block list nested inside a map", () => {
    const { frontmatter } = parseFrontmatter(`---
metadata:
  hermes:
    tags:
      - one
      - two
---
body
`);
    expect(frontmatter.metadata).toEqual({ hermes: { tags: ["one", "two"] } });
  });

  it("keeps quoted scalar values as-is (naive YAML subset)", () => {
    const { frontmatter } = parseFrontmatter(`---
version: "1.2.3"
description: 'A quoted description.'
---
body
`);
    expect(frontmatter.version).toBe('"1.2.3"');
    expect(frontmatter.description).toBe("'A quoted description.'");
  });

  it("preserves colons inside values", () => {
    const { frontmatter } = parseFrontmatter(`---
name: tool
url: https://example.com/a:b
---
body
`);
    expect(frontmatter.url).toBe("https://example.com/a:b");
  });

  it("skips comment and non-key-value lines inside frontmatter", () => {
    const { frontmatter } = parseFrontmatter(`---
# leading comment
name: ok-skill

some prose line without a colon
license: MIT
---
body
`);
    expect(frontmatter.name).toBe("ok-skill");
    expect(frontmatter.license).toBe("MIT");
    expect(frontmatter["some prose line without a colon"]).toBeUndefined();
  });

  it("handles an empty frontmatter block (blank line before the closing fence)", () => {
    const { frontmatter, body } = parseFrontmatter(`---

---
body
`);
    expect(frontmatter).toEqual({});
    expect(body).toBe("body\n");
  });

  it("does not parse `---\n---` directly (regex requires a newline before the closing fence)", () => {
    expect(() => parseFrontmatter("---\n---\nbody\n")).toThrow("missing frontmatter");
  });

  it("handles CRLF line endings", () => {
    const { frontmatter, body } = parseFrontmatter("---\r\nname: crlf-skill\r\ndescription: CRLF doc.\r\n---\r\nbody text\r\n");
    expect(frontmatter.name).toBe("crlf-skill");
    expect(body).toBe("body text\r\n");
  });

  it("strips a UTF-8 BOM before parsing", () => {
    const { frontmatter } = parseFrontmatter("\uFEFF---\nname: bom-skill\n---\nbody\n");
    expect(frontmatter.name).toBe("bom-skill");
  });

  it("keeps `---` separators inside the body intact", () => {
    const { body } = parseFrontmatter(`---
name: with-separator
---
Before

---

After
`);
    expect(body).toBe("Before\n\n---\n\nAfter\n");
  });

  it("returns an empty body when the closing fence is the end of content", () => {
    const { body } = parseFrontmatter("---\nname: no-body\n---");
    expect(body).toBe("");
  });

  it("throws 'missing frontmatter' when content has no frontmatter", () => {
    expect(() => parseFrontmatter("just plain text")).toThrow("missing frontmatter");
  });

  it("throws 'missing frontmatter' when the closing fence is missing", () => {
    expect(() => parseFrontmatter("---\nname: unclosed")).toThrow("missing frontmatter");
  });

  it("throws 'missing frontmatter' when content does not start with a fence", () => {
    expect(() => parseFrontmatter("\n---\nname: indented\n---\nbody\n")).toThrow("missing frontmatter");
  });

  it("throws 'missing frontmatter' for empty content", () => {
    expect(() => parseFrontmatter("")).toThrow("missing frontmatter");
  });

  it("parses keys with underscores, digits and dashes", () => {
    const { frontmatter } = parseFrontmatter(`---
my-key_1: value-1
---
body
`);
    expect(frontmatter["my-key_1"]).toBe("value-1");
  });
});
