#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  console.log(`Usage: node scripts/package-portable-windows.mjs [options]

Collects the built Windows executable and its Tauri resources from the cargo
target directory into a self-contained portable folder (with portable.marker
so the app anchors all data to <unzip dir>\\data), then zips it.

Run after \`pnpm tauri:build:bundled-windows\` (or tauri-action) on Windows.
The installer (NSIS) pipeline is untouched; this only adds an extra artifact.

Options:
  --target <triple>   Cargo target triple (e.g. x86_64-pc-windows-msvc).
                      Default: no triple (target/release).
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
const releaseDir = target
  ? join(repoRoot, "target", target, "release")
  : join(repoRoot, "target", "release");
const outRoot = resolve(repoRoot, argValue("--out", join("target", "portable")));

if (!existsSync(releaseDir)) {
  throw new Error(`release dir not found (build first): ${releaseDir}`);
}

// The Tauri CLI may leave the executable under its cargo name or rename it to
// the product name depending on version — probe both.
const exeCandidates = [`${productName}.exe`, `${pkg.name}.exe`];
const exeName = exeCandidates.find((name) => existsSync(join(releaseDir, name)));
if (!exeName) {
  const listing = readdirSync(releaseDir).join("\n  ");
  throw new Error(
    `no executable found in ${releaseDir} (tried: ${exeCandidates.join(", ")});\n` +
      `directory contents:\n  ${listing}`,
  );
}

// Resource layout mirrors tauri.conf.json bundle.resources: tauri-build copies
// each mapping's destination into the cargo target dir, and on Windows
// resource_dir() == the exe's directory, so the portable folder reproduces the
// NSIS install layout exactly.
const resourceDests = Object.values(tauriConf.bundle.resources).map((dest) =>
  dest.replace(/\/+$/, ""),
);

const archLabel = (target ?? "x86_64").startsWith("aarch64") ? "arm64" : "x64";
const stagingName = `${productName} Portable`;
const stagingDir = join(outRoot, stagingName);
const zipName = `${productName.replaceAll(" ", ".")}_${version}_${archLabel}-portable.zip`;
const zipPath = join(outRoot, zipName);

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

cpSync(join(releaseDir, exeName), join(stagingDir, `${productName}.exe`));
// Some Tauri/wry versions link WebView2Loader statically, others ship the DLL.
const webview2Loader = join(releaseDir, "WebView2Loader.dll");
if (existsSync(webview2Loader)) {
  cpSync(webview2Loader, join(stagingDir, "WebView2Loader.dll"));
}

for (const dest of resourceDests) {
  const source = join(releaseDir, dest);
  if (!existsSync(source)) {
    throw new Error(`bundled resource missing from target dir: ${source}`);
  }
  cpSync(source, join(stagingDir, dest), { recursive: true });
}

writeFileSync(
  join(stagingDir, "portable.marker"),
  [
    "Hermes Agent CN Desktop portable marker.",
    "此文件存在时，应用将把全部数据保存到本目录下的 data\\ 文件夹。",
    "请勿删除此文件，否则应用会退回系统默认数据目录。",
    "",
  ].join("\r\n"),
);

writeFileSync(
  join(stagingDir, "README-portable.txt"),
  [
    `Hermes Agent 中文社区桌面版 免安装版 v${version} (Windows ${archLabel})`,
    "",
    "使用方法：",
    `  双击 ${productName}.exe 直接运行，无需安装。`,
    "  全部数据（会话、配置、内核、缓存）都保存在本目录的 data\\ 文件夹。",
    "",
    "升级：",
    "  退出应用后，下载新版免安装压缩包，覆盖解压到本目录即可。",
    "  data\\ 文件夹会被保留，会话与配置不会丢失。",
    "",
    "注意事项：",
    "  - 请先把压缩包解压到一个可写目录再运行（不要在压缩软件里直接双击）。",
    "  - 首次运行需要系统已安装 WebView2 运行时（Windows 11 及多数 Windows 10",
    "    已自带）；缺失时应用会提示联网安装。",
    "  - 请勿删除 portable.marker 文件，它是免安装模式的开关。",
    "  - 同时打开多个副本时，后启动的实例会自动改用其他端口。",
    "",
  ].join("\r\n"),
);

mkdirSync(join(stagingDir, "data"), { recursive: true });
writeFileSync(
  join(stagingDir, "data", "README.txt"),
  "应用的全部数据保存在这里。升级覆盖解压时请保留此文件夹。\r\n",
);

// Prefer 7z (present on GitHub runners); fall back to Windows bsdtar.
function compress() {
  const sevenZip = spawnSync("7z", ["a", "-tzip", zipPath, stagingDir], {
    stdio: "inherit",
    cwd: outRoot,
    shell: false,
  });
  if (sevenZip.status === 0) return;
  const tar = spawnSync(
    "tar.exe",
    ["-a", "-cf", zipPath, "-C", outRoot, stagingName],
    { stdio: "inherit", shell: false },
  );
  if (tar.status !== 0) {
    throw new Error("failed to create portable zip: both 7z and tar.exe failed");
  }
}
compress();

if (!existsSync(zipPath)) {
  throw new Error(`portable zip was not created: ${zipPath}`);
}
console.log(`packaged portable zip: ${zipPath}`);
console.log(`from: ${releaseDir} (${basename(exeName)})`);
