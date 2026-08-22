import type { ServerDef } from "./types.js";

export const LSP_SERVERS: ServerDef[] = [
  { id: "pyright", languages: ["python"], extensions: [".py"], command: ["pyright-langserver", "--stdio"], description: "Python" },
  { id: "typescript", languages: ["typescript", "javascript"], extensions: [".ts", ".js"], command: ["typescript-language-server", "--stdio"], description: "TypeScript" },
  { id: "gopls", languages: ["go"], extensions: [".go"], command: ["gopls"], description: "Go" },
  { id: "rust-analyzer", languages: ["rust"], extensions: [".rs"], command: ["rust-analyzer"], description: "Rust" },
  { id: "clangd", languages: ["c", "cpp"], extensions: [".c", ".cpp"], command: ["clangd"], description: "C/C++" },
];

export function resolveServerIdForFile(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const server of LSP_SERVERS) {
    if (server.extensions.some((ext) => lower.endsWith(ext))) {
      return server.id;
    }
  }
  return undefined;
}
