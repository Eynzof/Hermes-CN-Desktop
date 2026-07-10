#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  console.log(`Usage: node scripts/package-portable-macos.mjs [options]

Packages the built (and ideally signed + notarized + stapled) .app bundle into
a portable zip: the .app plus portable.marker next to it, so the app anchors
all data to <unzip dir>/data instead of ~/Library. Uses \`ditto\` throughout to
preserve symlinks and code signatures (Python.framework inside the runtime).

Run after \`pnpm tauri:build:bundled-macos-*\` (or tauri-action + notarization).
The DMG pipeline is untouched; this only adds an extra artifact.

Options:
  --target <triple>   Cargo target triple (aarch64-apple-darwin or
                      x86_64-apple-darwin). Default: no triple (target/release).
  --out <dir>         Output dir for staging + zip (default: target/portable)
`);
}

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const tauriConf = JSON.parse(readFileSync(join(repoRoot, "tauri.conf.json"), "utf8"));

const version = pkg.version;
const productName = tauriConf.productName;
const target = argValue("--target", null);
const bundleMacosDir = target
  ? join(repoRoot, "target", target, "release", "bundle", "macos")
  : join(repoRoot, "target", "release", "bundle", "macos");
const outRoot = resolve(repoRoot, argValue("--out", join("target", "portable")));

const appPath = join(bundleMacosDir, `${productName}.app`);
if (!existsSync(appPath)) {
  throw new Error(`.app bundle not found (build first): ${appPath}`);
}

const archLabel = (target ?? "aarch64").startsWith("x86_64") ? "x64" : "aarch64";
const stagingName = `${productName} Portable`;
const stagingDir = join(outRoot, stagingName);
const zipName = `${productName.replaceAll(" ", ".")}_${version}_${archLabel}-portable.zip`;
const zipPath = join(outRoot, zipName);

function ditto(args) {
  const result = spawnSync("ditto", args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    throw new Error(`ditto ${args.join(" ")} failed with status ${result.status}`);
  }
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// ditto (not cpSync) keeps symlinks, resource forks, and code signatures
// intact — the runtime zip inside Resources embeds a signed Python.framework.
ditto([appPath, join(stagingDir, `${productName}.app`)]);

writeFileSync(
  join(stagingDir, "portable.marker"),
  [
    "Hermes Agent CN Desktop portable marker.",
    "此文件与 .app 同级存在时，应用会把全部数据保存到本目录下的 data/ 文件夹。",
    "请勿删除此文件，否则应用会退回 ~/Library 下的系统默认数据目录。",
    "",
  ].join("\n"),
);

writeFileSync(
  join(stagingDir, "README-portable.txt"),
  [
    `Hermes Agent 中文社区桌面版 免安装版 v${version} (macOS ${archLabel})`,
    "",
    "使用方法：",
    `  双击 ${productName}.app 直接运行，无需拖入「应用程序」。`,
    "  全部主数据（会话、配置、内核、缓存）都保存在本目录的 data/ 文件夹。",
    "",
    "首次运行（重要）：",
    "  macOS 会对下载的应用施加隔离（App Translocation），导致应用从临时",
    "  路径启动、找不到本目录。若启动后弹出相关提示，请任选其一：",
    "  1. 把解压出的整个文件夹移动到别的位置（例如从「下载」移到「文稿」），",
    "     然后重新打开；或",
    "  2. 在终端执行：xattr -dr com.apple.quarantine \"<本目录路径>\"",
    "",
    "升级：",
    "  退出应用后，下载新版免安装压缩包，覆盖解压到本目录即可。",
    "  data/ 文件夹会被保留，会话与配置不会丢失。",
    "",
    "已知限制：",
    "  - 网页视图（WKWebView）的 cookie 与本地存储由 macOS 管理，仍会写入",
    "    ~/Library；应用主数据不受影响。",
    "  - 请勿删除 portable.marker 文件，它是免安装模式的开关。",
    "  - 同时打开多个副本时，后启动的实例会自动改用其他端口。",
    "",
  ].join("\n"),
);

mkdirSync(join(stagingDir, "data"), { recursive: true });
writeFileSync(
  join(stagingDir, "data", "README.txt"),
  "应用的全部数据保存在这里。升级覆盖解压时请保留此文件夹。\n",
);

// --keepParent keeps the "<productName> Portable/" folder as the zip's single
// top-level entry so extraction is tidy; --sequesterRsrc preserves metadata.
ditto(["-c", "-k", "--sequesterRsrc", "--keepParent", stagingDir, zipPath]);

if (!existsSync(zipPath)) {
  throw new Error(`portable zip was not created: ${zipPath}`);
}
console.log(`packaged portable zip: ${zipPath}`);
console.log(`from: ${appPath}`);
