#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";

const SOUL_CHAR_LIMIT = 20_000;
const EXPECTED_PERSONA_COUNT = 215;
const MAPPED_UPSTREAM_IDS = new Set([
  "marketing-bilibili-strategist",
  "supply-chain-strategist",
]);

const categoryLabels = {
  academic: "学术研究",
  design: "设计体验",
  engineering: "工程开发",
  finance: "金融财务",
  "game-development": "游戏开发",
  gis: "地理信息",
  marketing: "市场营销",
  "paid-media": "付费投放",
  product: "产品管理",
  "project-management": "项目管理",
  sales: "销售增长",
  security: "安全合规",
  specialized: "专项专家",
  "spatial-computing": "空间计算",
  support: "客户支持",
  "supply-chain": "供应链",
  testing: "测试质量",
};

function fail(message) {
  console.error(`[persona-sync] ${message}`);
  process.exit(1);
}

function walkMarkdown(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if ([".git", ".github", "examples", "strategy"].includes(entry.name)) continue;
    const target = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(target));
    else if (entry.name.endsWith(".md")) files.push(target);
  }
  return files;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAgent(file) {
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatter) fail(`缺少 frontmatter：${file}`);

  const field = (name) => {
    const match = frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    if (!match) fail(`缺少 ${name}：${file}`);
    return unquote(match[1]);
  };

  const content = source
    .slice(frontmatter[0].length)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    // 避免模板中的七个等号被 Git 误判为未解决的冲突标记。
    .replace(/^={7}$/gm, "-------")
    .trim();

  return {
    name: field("name"),
    description: field("description"),
    emoji: field("emoji"),
    content,
  };
}

const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : null;
if (!sourceRoot || !existsSync(join(sourceRoot, "AGENT-LIST.md"))) {
  fail("用法：node scripts/sync-agency-personas.mjs <agency-agents-zh 仓库路径>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repositoryRoot, "web/src/data/persona-market");
const promptRoot = join(outputRoot, "prompts");
const agentList = readFileSync(join(sourceRoot, "AGENT-LIST.md"), "utf8");
const upstreamNotes = readFileSync(join(sourceRoot, "UPSTREAM.md"), "utf8");
const upstreamCommit = upstreamNotes.match(/对应 commit[^\n]*`([^`]+)`/)?.[1];
if (!upstreamCommit) fail("无法从 UPSTREAM.md 读取上游 commit");
const translationCommit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const listedRows = agentList
  .split("\n")
  .filter((line) => line.startsWith("| `"))
  .map((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    return {
      id: cells[1].slice(1, -1),
      origin: cells.at(-2),
    };
  });
const ids = new Set(
  listedRows
    .filter(({ id, origin }) => origin === "翻译" || MAPPED_UPSTREAM_IDS.has(id))
    .map(({ id }) => id),
);

if (ids.size !== EXPECTED_PERSONA_COUNT) {
  fail(`预期 ${EXPECTED_PERSONA_COUNT} 个上游译本人格，实际 ${ids.size} 个`);
}

const allAgentFiles = walkMarkdown(sourceRoot);
const fileById = new Map(allAgentFiles.map((file) => [basename(file, ".md"), file]));
const personas = [...ids].map((id) => {
  const file = fileById.get(id);
  if (!file) fail(`找不到人格文件：${id}`);
  const category = relative(sourceRoot, file).split(sep)[0];
  if (!categoryLabels[category]) fail(`未知部门 ${category}：${file}`);
  const agent = parseAgent(file);
  if (!agent.content) fail(`提示词为空：${file}`);
  if (agent.content.length > SOUL_CHAR_LIMIT) {
    fail(`${id} 超出 SOUL.md 上限：${agent.content.length} > ${SOUL_CHAR_LIMIT}`);
  }
  return {
    id,
    category,
    categoryLabel: categoryLabels[category],
    sourcePath: relative(sourceRoot, file).split(sep).join("/"),
    characterCount: agent.content.length,
    ...agent,
  };
});

personas.sort((left, right) => (
  left.categoryLabel.localeCompare(right.categoryLabel, "zh-CN")
  || left.name.localeCompare(right.name, "zh-CN")
));

rmSync(promptRoot, { recursive: true, force: true });
mkdirSync(promptRoot, { recursive: true });

for (const persona of personas) {
  writeFileSync(join(promptRoot, `${persona.id}.md`), `${persona.content}\n`);
}

const manifest = personas.map(({ content: _content, ...persona }) => persona);
const generated = `// 此文件由 scripts/sync-agency-personas.mjs 生成，请勿手改。\n\n`
  + `export const PERSONA_SOURCE = ${JSON.stringify({
    upstreamRepository: "https://github.com/msitarzewski/agency-agents",
    upstreamCommit,
    translationRepository: "https://github.com/jnMetaCode/agency-agents-zh",
    translationCommit,
    license: "MIT",
  }, null, 2)} as const;\n\n`
  + `export const PERSONA_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n`;

writeFileSync(join(outputRoot, "personas.generated.ts"), generated);
cpSync(join(sourceRoot, "LICENSE"), join(repositoryRoot, "legal/agency-agents.MIT.txt"));

console.log(`[persona-sync] 已生成 ${personas.length} 个中文人格，写入 ${relative(repositoryRoot, outputRoot)}`);
