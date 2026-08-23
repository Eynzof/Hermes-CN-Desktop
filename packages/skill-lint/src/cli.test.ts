import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import type { LintResult } from "./types.js";

const lintTreeMock = vi.hoisted(() => vi.fn());
const hasErrorsMock = vi.hoisted(() => vi.fn());

vi.mock("./lint.js", () => ({
  lintTree: lintTreeMock,
  hasErrors: hasErrorsMock,
}));

const emptyResult: LintResult = {
  version: 1,
  roots: ["."],
  skills: [],
  totals: { errors: 0, warnings: 0 },
};

const findingResult: LintResult = {
  version: 1,
  roots: ["skills/a"],
  skills: [
    {
      path: "skills/a/SKILL.md",
      name: "a",
      findings: [
        { severity: "error", rule: "name-format", message: "bad name" },
        { severity: "warning", rule: "description-length", message: "too long" },
      ],
    },
    { path: "skills/b/SKILL.md", name: "b", findings: [] },
  ],
  totals: { errors: 1, warnings: 1 },
};

describe("runCli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lintTreeMock.mockReset();
    hasErrorsMock.mockReset();
    lintTreeMock.mockReturnValue(emptyResult);
    hasErrorsMock.mockReturnValue(false);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("lints '.' by default when no --source is given", async () => {
    const code = await runCli([]);
    expect(lintTreeMock).toHaveBeenCalledTimes(1);
    expect(lintTreeMock).toHaveBeenCalledWith(["."], { json: false });
    expect(code).toBe(0);
  });

  it("collects all positional roots after --source", async () => {
    await runCli(["--source", "../Hermes-CN-Core/skills", "../Hermes-CN-Core/optional-skills"]);
    expect(lintTreeMock).toHaveBeenCalledWith(
      ["../Hermes-CN-Core/skills", "../Hermes-CN-Core/optional-skills"],
      { json: false },
    );
  });

  it("stops collecting roots at the next --flag", async () => {
    await runCli(["--source", "skills", "--json", "extra"]);
    expect(lintTreeMock).toHaveBeenCalledWith(["skills"], { json: true });
  });

  it("supports --json without --source", async () => {
    await runCli(["--json"]);
    expect(lintTreeMock).toHaveBeenCalledWith(["."], { json: true });
  });

  it("prints a JSON report when --json is passed", async () => {
    lintTreeMock.mockReturnValue(findingResult);
    await runCli(["--json"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed).toEqual(findingResult);
    expect(printed.totals).toEqual({ errors: 1, warnings: 1 });
  });

  it("prints a human-readable summary without --json", async () => {
    lintTreeMock.mockReturnValue(findingResult);
    await runCli(["--source", "skills/a"]);
    const summary = logSpy.mock.calls[0][0] as string;
    expect(summary).toContain("skills/a/SKILL.md");
    expect(summary).toContain("✗ [name-format] bad name");
    expect(summary).toContain("⚠ [description-length] too long");
    expect(summary).toContain("Totals: 1 errors, 1 warnings");
    // Skills without findings are not listed.
    expect(summary).not.toContain("skills/b/SKILL.md");
  });

  it("prints totals of zero for a clean tree", async () => {
    await runCli([]);
    expect(logSpy.mock.calls[0][0]).toContain("Totals: 0 errors, 0 warnings");
  });

  it("exits 1 when any finding is an error", async () => {
    hasErrorsMock.mockReturnValue(true);
    const code = await runCli(["--source", "skills/a"]);
    expect(code).toBe(1);
  });

  it("exits 0 when there are warnings but no errors", async () => {
    hasErrorsMock.mockReturnValue(false);
    const code = await runCli(["--source", "skills/a"]);
    expect(code).toBe(0);
  });

  it("passes the flattened findings to hasErrors", async () => {
    lintTreeMock.mockReturnValue(findingResult);
    await runCli(["--source", "skills/a"]);
    expect(hasErrorsMock).toHaveBeenCalledWith([
      { severity: "error", rule: "name-format", message: "bad name" },
      { severity: "warning", rule: "description-length", message: "too long" },
    ]);
  });
});
