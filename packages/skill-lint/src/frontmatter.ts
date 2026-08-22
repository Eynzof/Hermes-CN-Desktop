import type { SkillFrontmatter } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function trimBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseYamlLike(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  let i = 0;

  function indentOf(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === " ") n++;
    return n;
  }

  function parseBlock(baseIndent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw || !raw.trim()) {
        i++;
        continue;
      }
      const ind = indentOf(raw);
      if (ind <= baseIndent) break;
      const m = raw.match(/^\s*([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1];
      const rest = m[2].trim();
      i++;
      if (!rest) {
        // Determine if the following lines form a list or nested map.
        if (i < lines.length) {
          const nextInd = indentOf(lines[i]);
          if (nextInd > ind) {
            const first = lines[i].trim();
            if (first.startsWith("- ")) {
              const arr: string[] = [];
              while (i < lines.length) {
                const line = lines[i];
                if (!line.trim()) {
                  i++;
                  continue;
                }
                if (indentOf(line) <= ind) break;
                const t = line.trim();
                if (t.startsWith("- ")) {
                  arr.push(t.slice(2).trim());
                  i++;
                } else {
                  i++;
                }
              }
              obj[key] = arr;
              continue;
            }
          }
        }
        const child = parseBlock(ind);
        if (Object.keys(child).length) obj[key] = child;
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        obj[key] = parseInlineList(rest);
      } else {
        obj[key] = rest;
      }
    }
    return obj;
  }

  return parseBlock(-1);
}

export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const text = trimBom(content);
  const m = FRONTMATTER_RE.exec(text);
  if (!m) throw new Error("missing frontmatter");
  const raw = parseYamlLike(m[1]);
  return {
    frontmatter: raw as SkillFrontmatter,
    body: m[2] ?? "",
  };
}
