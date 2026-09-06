import { describe, expect, it } from "vitest";
import { replaceSkillFrontmatterName } from "./use-skills";

describe("replaceSkillFrontmatterName", () => {
  it("renames only the frontmatter identity while preserving the body", () => {
    const source = "---\r\nname: bundled-skill\r\ndescription: Use bundled-skill safely.\r\n---\r\n# bundled-skill\r\n";
    expect(replaceSkillFrontmatterName(source, "bundled-skill-custom")).toBe(
      "---\r\nname: bundled-skill-custom\r\ndescription: Use bundled-skill safely.\r\n---\r\n# bundled-skill\r\n",
    );
  });
});
