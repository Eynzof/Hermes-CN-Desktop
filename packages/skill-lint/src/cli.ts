import { hasErrors } from "./lint.js";
import { lintTree } from "./lint-tree.js";

export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const sourceIdx = argv.indexOf("--source");
  const roots: string[] = [];
  if (sourceIdx >= 0) {
    for (let i = sourceIdx + 1; i < argv.length; i++) {
      if (argv[i].startsWith("--")) break;
      roots.push(argv[i]);
    }
  }
  const result = lintTree(roots.length ? roots : ["."], { json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatFindingsSummary(result));
  }
  return hasErrors(result.skills.flatMap((s) => s.findings)) ? 1 : 0;
}

function formatFindingsSummary(result: import("./types.js").LintResult): string {
  const lines: string[] = [];
  for (const skill of result.skills) {
    if (!skill.findings.length) continue;
    lines.push(`\n${skill.path}`);
    for (const f of skill.findings) {
      lines.push(`  ${f.severity === "error" ? "✗" : "⚠"} [${f.rule}] ${f.message}`);
    }
  }
  lines.push(`\nTotals: ${result.totals.errors} errors, ${result.totals.warnings} warnings`);
  return lines.join("\n");
}
