import { describe, expect, it } from "vitest";
import {
  checkAuthorCaps,
  checkDanglingReference,
  checkDescriptionLength,
  checkDescriptionMarketing,
  checkForbiddenFile,
  checkMissingMetadata,
  checkMissingSection,
  checkNameDirMismatch,
  checkNameFormat,
  checkPlatformsGating,
  checkPlatformsValue,
  checkRelatedSkills,
  checkShellUtilityReference,
} from "./rules.js";
import type { LintOptions, SkillFrontmatter } from "./types.js";

describe("checkNameFormat", () => {
  it("accepts lowercase letters, digits, '-' and '_'", () => {
    expect(checkNameFormat("my-skill_2")).toEqual([]);
    expect(checkNameFormat("a")).toEqual([]);
    expect(checkNameFormat("123")).toEqual([]);
  });

  it("rejects uppercase letters", () => {
    const findings = checkNameFormat("MySkill");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", rule: "name-format" });
    expect(findings[0].message).toContain("MySkill");
  });

  it("rejects spaces and other punctuation", () => {
    expect(checkNameFormat("my skill")).toHaveLength(1);
    expect(checkNameFormat("my.skill")).toHaveLength(1);
    expect(checkNameFormat("my/skill")).toHaveLength(1);
  });

  it("rejects an empty string (no characters at all)", () => {
    expect(checkNameFormat("")).toHaveLength(1);
  });

  it("ignores non-string values", () => {
    expect(checkNameFormat(undefined)).toEqual([]);
    expect(checkNameFormat(null)).toEqual([]);
    expect(checkNameFormat(42)).toEqual([]);
    expect(checkNameFormat(["a"])).toEqual([]);
  });
});

describe("checkNameDirMismatch", () => {
  const base: SkillFrontmatter = { name: "sample-skill" };

  it("passes when the name matches the directory", () => {
    expect(checkNameDirMismatch(base, { skillDir: "skills/sample-skill" })).toEqual([]);
  });

  it("errors when the name does not match the directory", () => {
    const findings = checkNameDirMismatch({ name: "other-skill" }, { skillDir: "skills/sample-skill" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", rule: "name-dir-mismatch" });
    expect(findings[0].message).toContain("other-skill");
    expect(findings[0].message).toContain("sample-skill");
  });

  it("normalizes Windows-style directory separators", () => {
    expect(checkNameDirMismatch(base, { skillDir: "skills\\sample-skill" })).toEqual([]);
    expect(checkNameDirMismatch({ name: "other" }, { skillDir: "skills\\sample-skill" })).toHaveLength(1);
  });

  it("skips the check when no skillDir is provided", () => {
    expect(checkNameDirMismatch(base, {})).toEqual([]);
  });

  it("skips the check for a non-string name", () => {
    expect(checkNameDirMismatch({ name: 42 as unknown as string }, { skillDir: "skills/42" })).toEqual([]);
  });

  it("treats a trailing-slash dir as unverifiable (empty basename)", () => {
    expect(checkNameDirMismatch({ name: "x" }, { skillDir: "skills/sample-skill/" })).toEqual([]);
  });
});

describe("checkDescriptionLength", () => {
  it("passes at exactly the 60-character limit", () => {
    expect(checkDescriptionLength({ description: "a".repeat(60) })).toEqual([]);
  });

  it("warns when the description exceeds 60 characters", () => {
    const findings = checkDescriptionLength({ description: "a".repeat(61) });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "description-length" });
    expect(findings[0].message).toContain("60");
  });

  it("ignores missing or non-string descriptions", () => {
    expect(checkDescriptionLength({})).toEqual([]);
    expect(checkDescriptionLength({ description: undefined })).toEqual([]);
    expect(checkDescriptionLength({ description: 42 as unknown as string })).toEqual([]);
  });
});

describe("checkDescriptionMarketing", () => {
  it("passes for a plain description", () => {
    expect(checkDescriptionMarketing({ description: "A sample skill." })).toEqual([]);
  });

  it("warns on a single marketing word (case-insensitive)", () => {
    const findings = checkDescriptionMarketing({ description: "A REVOLUTIONARY skill" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "description-marketing" });
    expect(findings[0].message).toContain("revolutionary");
  });

  it("lists all marketing words found", () => {
    const findings = checkDescriptionMarketing({ description: "The best and most powerful skill" });
    expect(findings[0].message).toContain("best");
    expect(findings[0].message).toContain("powerful");
  });

  it("ignores missing or non-string descriptions", () => {
    expect(checkDescriptionMarketing({})).toEqual([]);
    expect(checkDescriptionMarketing({ description: 5 as unknown as string })).toEqual([]);
  });
});

describe("checkMissingMetadata", () => {
  it("passes when version/author/license and tags are present", () => {
    const fm: SkillFrontmatter = {
      version: "1.0.0",
      author: "Hermes",
      license: "MIT",
      metadata: { hermes: { tags: ["sample"] } },
    };
    expect(checkMissingMetadata(fm)).toEqual([]);
  });

  it("warns when version is missing", () => {
    const findings = checkMissingMetadata({ author: "Hermes", license: "MIT", metadata: { hermes: { tags: ["x"] } } });
    expect(findings[0].message).toContain("version");
  });

  it("warns when author is missing", () => {
    const findings = checkMissingMetadata({ version: "1.0.0", license: "MIT", metadata: { hermes: { tags: ["x"] } } });
    expect(findings[0].message).toContain("author");
  });

  it("warns when license is missing", () => {
    const findings = checkMissingMetadata({ version: "1.0.0", author: "Hermes", metadata: { hermes: { tags: ["x"] } } });
    expect(findings[0].message).toContain("license");
  });

  it("warns when metadata.hermes.tags is missing or empty", () => {
    const fm: SkillFrontmatter = { version: "1.0.0", author: "Hermes", license: "MIT" };
    expect(checkMissingMetadata(fm)[0].message).toContain("metadata.hermes.tags");
    const emptyTags = { ...fm, metadata: { hermes: { tags: [] } } };
    expect(checkMissingMetadata(emptyTags)[0].message).toContain("metadata.hermes.tags");
    const nonArrayTags = { ...fm, metadata: { hermes: { tags: "x" as unknown as string[] } } };
    expect(checkMissingMetadata(nonArrayTags)[0].message).toContain("metadata.hermes.tags");
  });

  it("aggregates all missing fields in one finding", () => {
    const findings = checkMissingMetadata({});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "missing-metadata" });
    for (const field of ["version", "author", "license", "metadata.hermes.tags"]) {
      expect(findings[0].message).toContain(field);
    }
  });
});

describe("checkAuthorCaps", () => {
  it("passes for normal casing", () => {
    expect(checkAuthorCaps({ author: "Hermes" })).toEqual([]);
    expect(checkAuthorCaps({ author: "John Smith" })).toEqual([]);
  });

  it("warns on runs of two or more uppercase letters", () => {
    expect(checkAuthorCaps({ author: "HERMES" })).toHaveLength(1);
    expect(checkAuthorCaps({ author: "IBM Corp" })).toHaveLength(1);
    expect(checkAuthorCaps({ author: "Acme INC." })).toHaveLength(1);
  });

  it("ignores empty or non-string authors", () => {
    expect(checkAuthorCaps({})).toEqual([]);
    expect(checkAuthorCaps({ author: "" })).toEqual([]);
    expect(checkAuthorCaps({ author: 7 as unknown as string })).toEqual([]);
  });
});

describe("checkShellUtilityReference", () => {
  it("passes for prose without shell utilities", () => {
    expect(checkShellUtilityReference({}, "Use this skill to summarize documents.")).toEqual([]);
  });

  it("warns when prose references a shell utility", () => {
    const findings = checkShellUtilityReference({}, "Run grep to filter the output");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "shell-utility-reference" });
    expect(findings[0].message).toContain("grep");
  });

  it("matches case-insensitively", () => {
    expect(checkShellUtilityReference({}, "Use CAT to concatenate files")).toHaveLength(1);
    expect(checkShellUtilityReference({}, "Use Cat to concatenate files")).toHaveLength(1);
    expect(checkShellUtilityReference({}, "use cat to concatenate files")).toHaveLength(1);
  });

  it("lists every utility found", () => {
    const findings = checkShellUtilityReference({}, "Pipe ls into grep, then use sed");
    expect(findings[0].message).toContain("ls");
    expect(findings[0].message).toContain("grep");
    expect(findings[0].message).toContain("sed");
  });

  it("ignores references inside fenced code blocks", () => {
    const body = "```bash\ngrep foo bar.txt\n```\n\nThen summarize.";
    expect(checkShellUtilityReference({}, body)).toEqual([]);
  });

  it("ignores references inside inline backticks", () => {
    expect(checkShellUtilityReference({}, "Run `grep -r` on the tree")).toEqual([]);
  });

  it("does not match partial words", () => {
    expect(checkShellUtilityReference({}, "The grape harvest was great")).toEqual([]);
    expect(checkShellUtilityReference({}, "scattered notes")).toEqual([]);
  });

  it("ignores missing bodies", () => {
    expect(checkShellUtilityReference({}, "")).toEqual([]);
  });
});

describe("checkMissingSection", () => {
  it("passes when the expected section is present", () => {
    expect(checkMissingSection({}, "## When to Use\n\nUse it when needed.")).toEqual([]);
  });

  it("warns when '## When to Use' is missing", () => {
    const findings = checkMissingSection({}, "## Usage\n\nJust use it.");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "missing-section" });
    expect(findings[0].message).toContain("## When to Use");
  });
});

describe("checkDanglingReference", () => {
  it("returns no findings without a skillDir (cannot verify)", () => {
    expect(checkDanglingReference({}, "See references/guide.md for details.", {})).toEqual([]);
  });

  it("is a stub with a skillDir: never reads disk, returns no findings", () => {
    const opts: LintOptions = { skillDir: "skills/sample" };
    expect(checkDanglingReference({}, "See references/guide.md and templates/tmpl.txt.", opts)).toEqual([]);
    expect(checkDanglingReference({}, "assets/logo.png", opts)).toEqual([]);
  });
});

describe("checkPlatformsGating", () => {
  it("passes when platforms are declared", () => {
    const fm: SkillFrontmatter = { platforms: ["linux"] };
    expect(checkPlatformsGating(fm, "Run scripts/setup.sh which uses grep.")).toEqual([]);
  });

  it("warns when scripts/ are referenced with POSIX primitives and no platforms", () => {
    const findings = checkPlatformsGating({}, "Run scripts/setup.sh; it pipes through grep and sed.");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "platforms-gating" });
    expect(findings[0].message).toContain("grep");
    expect(findings[0].message).toContain("sed");
  });

  it("passes when scripts/ are referenced but prose has no POSIX primitives", () => {
    expect(checkPlatformsGating({}, "Run scripts/setup.sh on any machine.")).toEqual([]);
  });

  it("passes when POSIX primitives appear but no scripts/ reference exists", () => {
    expect(checkPlatformsGating({}, "grep is mentioned in prose without scripts.")).toEqual([]);
  });

  it("ignores POSIX primitives inside code blocks", () => {
    expect(checkPlatformsGating({}, "```sh\nfind . -name '*.py'\n```\nRun scripts/lint.sh after.")).toEqual([]);
  });
});

describe("checkForbiddenFile", () => {
  it("is a stub: returns no findings even with a skillDir", () => {
    const opts: LintOptions = { skillDir: "skills/sample" };
    expect(checkForbiddenFile({}, "", opts)).toEqual([]);
    expect(checkForbiddenFile({}, "", {})).toEqual([]);
  });
});

describe("checkPlatformsValue", () => {
  it("passes for valid platform values", () => {
    expect(checkPlatformsValue({ platforms: ["linux", "macos", "windows", "darwin"] })).toEqual([]);
    expect(checkPlatformsValue({ platforms: "linux" })).toEqual([]);
    expect(checkPlatformsValue({ platforms: [] })).toEqual([]);
  });

  it("warns on invalid platform values in an array", () => {
    const findings = checkPlatformsValue({ platforms: ["linux", "win32"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "platforms-value" });
    expect(findings[0].message).toContain("win32");
  });

  it("warns on an invalid scalar platform", () => {
    expect(checkPlatformsValue({ platforms: "unix" })[0].message).toContain("unix");
  });

  it("passes when platforms is missing", () => {
    expect(checkPlatformsValue({})).toEqual([]);
  });
});

describe("checkRelatedSkills", () => {
  const allNames: LintOptions = { allNames: ["sample-skill", "other-skill"] };

  it("passes when related skills resolve in allNames", () => {
    const fm: SkillFrontmatter = { related_skills: ["sample-skill"] };
    expect(checkRelatedSkills(fm, "", allNames)).toEqual([]);
  });

  it("warns when a related skill is missing from allNames", () => {
    const findings = checkRelatedSkills({ related_skills: ["ghost-skill"] }, "", allNames);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", rule: "related-skills" });
    expect(findings[0].message).toContain("ghost-skill");
  });

  it("reads related skills from metadata.hermes.related_skills", () => {
    const fm: SkillFrontmatter = { metadata: { hermes: { related_skills: ["ghost-skill"] } } };
    expect(checkRelatedSkills(fm, "", allNames)[0].message).toContain("ghost-skill");
  });

  it("skips the check when allNames is not provided", () => {
    expect(checkRelatedSkills({ related_skills: ["ghost-skill"] }, "", {})).toEqual([]);
  });

  it("ignores missing or non-array related skills", () => {
    expect(checkRelatedSkills({}, "", allNames)).toEqual([]);
    expect(checkRelatedSkills({ related_skills: "sample-skill" as unknown as string[] }, "", allNames)).toEqual([]);
  });
});
