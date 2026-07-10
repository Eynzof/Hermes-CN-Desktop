// 把内置供应商目录导出为远端分发用的 provider-catalog.json。
//
// 用法（在 web/ 目录下）：
//   npx vite-node scripts/export-provider-catalog.ts [输出路径]
//
// 产物发布到 landing 仓库 public/api/provider-catalog.json，桌面端通过
// VITE_HERMES_PROVIDER_CATALOG_URL 在启动时拉取并按 id 合并。发版前重新
// 生成一次保持基线同步；日常改邀请码/推广位直接编辑 landing 上的 JSON。
import { writeFileSync } from "node:fs";
import { BUILTIN_PROVIDER_CATALOG } from "../src/lib/provider-catalog";

const out = process.argv[2] ?? "provider-catalog.json";
const payload = {
  version: BUILTIN_PROVIDER_CATALOG.version,
  updatedAt: new Date().toISOString(),
  metadata: {
    source: "Hermes-CN-Desktop web/src/lib/provider-catalog.ts",
    note: "远端字段无法覆盖内置供应商的 baseUrl/apiMode/transport/apiKeyLabel（安全防护）；promotion.url 必须是 https。",
  },
  providers: BUILTIN_PROVIDER_CATALOG.providers,
};

writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${out}: ${payload.providers.length} providers, version ${payload.version}`);
