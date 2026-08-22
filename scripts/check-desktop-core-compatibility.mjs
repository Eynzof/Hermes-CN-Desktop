#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(repoRoot, "compatibility", "desktop-core.json");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function series(version, label) {
  const match = String(version).trim().replace(/^[vV]/, "").match(/^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/);
  if (!match) throw new Error(`${label} 版本格式无效：${version}`);
  return `${Number(match[1])}.${Number(match[2])}`;
}

function validateSeries(value, label) {
  if (!/^\d+\.\d+$/.test(value)) {
    throw new Error(`${label} 必须是 major.minor：${value}`);
  }
}

function parseCoreVersion(coreRoot) {
  const pyproject = readFileSync(resolve(coreRoot, "pyproject.toml"), "utf8");
  const version = pyproject.match(/^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`无法从 ${coreRoot}/pyproject.toml 读取 [project].version`);
  return version;
}

const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
if (matrix.schemaVersion !== 1 || !Array.isArray(matrix.rules) || matrix.rules.length === 0) {
  throw new Error("兼容矩阵 schemaVersion/rules 无效");
}

const desktopRules = new Set();
for (const rule of matrix.rules) {
  validateSeries(rule.desktopSeries, "desktopSeries");
  if (desktopRules.has(rule.desktopSeries)) {
    throw new Error(`重复 desktopSeries：${rule.desktopSeries}`);
  }
  desktopRules.add(rule.desktopSeries);
  if (!Array.isArray(rule.coreSeries) || rule.coreSeries.length === 0) {
    throw new Error(`desktopSeries=${rule.desktopSeries} 缺少 coreSeries`);
  }
  for (const coreSeries of rule.coreSeries) validateSeries(coreSeries, "coreSeries");
}

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const desktopVersion = option("--desktop") ?? packageJson.version;
const desktopSeries = series(desktopVersion, "Desktop");
const rule = matrix.rules.find((item) => item.desktopSeries === desktopSeries);
if (!rule) throw new Error(`兼容矩阵未声明 Desktop ${desktopSeries}.x`);

function assertCoreCompatible(coreVersion, label) {
  const coreSeries = series(coreVersion, label);
  if (!rule.coreSeries.includes(coreSeries)) {
    throw new Error(
      `Desktop ${desktopSeries}.x 仅兼容 Core ${rule.coreSeries.map((v) => `${v}.x`).join(" / ")}，${label} 为 ${coreVersion}`,
    );
  }
}

const coreRoot = option("--core");
if (coreRoot) assertCoreCompatible(parseCoreVersion(resolve(coreRoot)), "Core source");

const runtimeManifestPath = option("--runtime-manifest");
if (runtimeManifestPath) {
  const manifest = JSON.parse(readFileSync(resolve(runtimeManifestPath), "utf8"));
  assertCoreCompatible(manifest.kernelVersion, "Runtime kernel");
  assertCoreCompatible(manifest.runtimeVersion, "Runtime package");
  if (
    Array.isArray(rule.runtimeManifestSchemas)
    && !rule.runtimeManifestSchemas.includes(manifest.schemaVersion)
  ) {
    throw new Error(
      `Desktop ${desktopSeries}.x 不接受 runtime manifest schema ${manifest.schemaVersion}`,
    );
  }
}

console.log(
  `兼容矩阵通过：Desktop ${desktopVersion} → Core ${rule.coreSeries.map((v) => `${v}.x`).join(" / ")}`,
);
