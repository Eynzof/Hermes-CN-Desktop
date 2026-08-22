import type { LspDiagnostic } from "./types.js";

export function reportDiagnostics(diagnostics: LspDiagnostic[], file: string): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics.map((d) => {
    const sev = ["ERROR", "WARN", "INFO", "HINT"][(d.severity ?? 1) - 1] ?? "DIAG";
    return `<diagnostic file="${escapeHtml(file)}" line="${d.range.start.line}" severity="${sev}">${escapeHtml(d.message)}</diagnostic>`;
  });
  return `<diagnostics file="${escapeHtml(file)}">\n${lines.join("\n")}\n</diagnostics>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
