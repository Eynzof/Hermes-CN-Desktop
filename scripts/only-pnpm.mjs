#!/usr/bin/env node
// pnpm-only guard：阻止用 npm / yarn 安装依赖，避免重新引入 package-lock.json
// 与 pnpm-lock.yaml 共存导致依赖树漂移（仓库脚本与 CI 全部使用 pnpm）。
//
// 包管理器在执行 (pre)install 时会把自己写进 npm_config_user_agent，
// 形如 "pnpm/9.15.0 npm/? node/v20...". 这里据此判断调用方。
const ua = process.env.npm_config_user_agent ?? "";

if (!ua.startsWith("pnpm")) {
  const pm = ua.split("/")[0] || "非 pnpm 的包管理器";
  console.error(
    `\n本仓库只使用 pnpm。检测到通过 ${pm} 安装，请改用 pnpm：\n\n    pnpm install\n`,
  );
  process.exit(1);
}
