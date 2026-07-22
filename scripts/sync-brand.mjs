#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const validateAll = process.argv.includes("--validate-all");
const DEFAULT_BRAND = "hermesagent";
const STABLE_BUNDLE_IDENTIFIER = "cn.org.hermesagent.desktop";

const REQUIRED_STRING_FIELDS = [
  "id",
  "appName",
  "appNameEn",
  "productName",
  "identifier",
  "dataDirName",
  "providerKey",
  "serviceUrl",
  "registerUrl",
  "rechargeUrl",
  "copyright",
  "publisher",
  "homepage",
  "shortDescription",
  "longDescription",
  "tagline",
  "edition",
  "updateManifestUrl",
  "updateDownloadUrl",
];
const REQUIRED_ARRAY_FIELDS = ["accountDefaultModels"];
const OPTIONAL_RECORD_FIELDS = ["accountModelDescriptions"];
const URL_FIELDS = [
  "serviceUrl",
  "registerUrl",
  "rechargeUrl",
  "homepage",
  "updateManifestUrl",
  "updateDownloadUrl",
];

function pathOf(relativePath) {
  return resolve(repoRoot, relativePath);
}

function readText(relativePath) {
  return readFileSync(pathOf(relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireBrand(requestedBrandId = process.env.BRAND || DEFAULT_BRAND) {
  const brandId = requestedBrandId.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(brandId)) {
    throw new Error(`Invalid BRAND id: ${JSON.stringify(brandId)} (expected lowercase kebab-case)`);
  }

  let brand;
  try {
    brand = readJson(`brands/${brandId}.json`);
  } catch (error) {
    throw new Error(`Cannot read brands/${brandId}.json; is BRAND=${brandId} configured?`, { cause: error });
  }

  const missingStrings = REQUIRED_STRING_FIELDS.filter(
    (field) => typeof brand[field] !== "string" || brand[field].trim().length === 0,
  );
  if (missingStrings.length > 0) {
    throw new Error(`brands/${brandId}.json missing required string fields: ${missingStrings.join(", ")}`);
  }

  const invalidArrays = REQUIRED_ARRAY_FIELDS.filter(
    (field) => !Array.isArray(brand[field])
      || brand[field].length === 0
      || brand[field].some((item) => typeof item !== "string" || item.trim().length === 0),
  );
  if (invalidArrays.length > 0) {
    throw new Error(`brands/${brandId}.json has invalid non-empty string arrays: ${invalidArrays.join(", ")}`);
  }

  if (brand.id !== brandId) {
    throw new Error(`brands/${brandId}.json has id=${JSON.stringify(brand.id)} but filename implies ${JSON.stringify(brandId)}`);
  }
  if (brand.identifier !== STABLE_BUNDLE_IDENTIFIER) {
    throw new Error(
      `brands/${brandId}.json must keep the upgrade-safe identifier ${STABLE_BUNDLE_IDENTIFIER}`,
    );
  }

  for (const field of OPTIONAL_RECORD_FIELDS) {
    if (brand[field] === undefined) continue;
    const value = brand[field];
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.entries(value).some(([key, item]) => key.trim().length === 0 || typeof item !== "string")) {
      throw new Error(`brands/${brandId}.json has invalid ${field}: expected a string record`);
    }
  }

  for (const field of URL_FIELDS) {
    let parsed;
    try {
      parsed = new URL(brand[field]);
    } catch {
      throw new Error(`brands/${brandId}.json has invalid URL in ${field}: ${JSON.stringify(brand[field])}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`brands/${brandId}.json ${field} must use http or https`);
    }
  }

  return brand;
}

if (validateAll) {
  const brandIds = readdirSync(pathOf("brands"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  if (brandIds.length === 0) throw new Error("No brand configs found under brands/");
  for (const brandId of brandIds) requireBrand(brandId);
  console.log(`Validated ${brandIds.length} brand configs: ${brandIds.join(", ")}`);
}

const brand = requireBrand();
const windowTitle = `${brand.appName} ${brand.edition}`.trim();
const changed = [];

function updateText(relativePath, updater) {
  const before = readText(relativePath);
  const after = updater(before);
  if (after === before) return;
  changed.push(relativePath);
  if (!checkOnly) writeFileSync(pathOf(relativePath), after);
}

function writeGenerated(relativePath, content) {
  let before = null;
  try {
    before = readText(relativePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (before === content) return;
  changed.push(relativePath);
  if (!checkOnly) writeFileSync(pathOf(relativePath), content);
}

function updateJson(relativePath, updater) {
  const value = readJson(relativePath);
  updater(value);
  updateText(relativePath, () => stableJson(value));
}

function replaceOrThrow(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`Cannot find ${label}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

updateJson("tauri.conf.json", (config) => {
  config.productName = brand.productName;
  config.identifier = STABLE_BUNDLE_IDENTIFIER;
  if (Array.isArray(config.app?.windows) && config.app.windows[0]) {
    config.app.windows[0].title = windowTitle;
  }
  if (config.bundle) {
    config.bundle.publisher = brand.publisher;
    config.bundle.homepage = brand.homepage;
    config.bundle.copyright = brand.copyright;
    config.bundle.shortDescription = brand.shortDescription;
    config.bundle.longDescription = brand.longDescription;
  }
});

updateText("Cargo.toml", (text) => replaceOrThrow(
  text,
  /(^\[package\][\s\S]*?^description\s*=\s*)"[^"]+"/m,
  `$1${JSON.stringify(brand.shortDescription)}`,
  "Cargo.toml [package].description",
));

const tsBanner = "// AUTO-GENERATED by scripts/sync-brand.mjs - do not edit by hand.\n"
  + `// Active brand: ${brand.id}. Run \`pnpm brand:sync\` with BRAND=<id> to regenerate.\n`;
const tsModule = `${tsBanner}\nexport interface BrandConfig {\n`
  + REQUIRED_STRING_FIELDS.map((field) => `  ${field}: string;`).join("\n")
  + "\n"
  + REQUIRED_ARRAY_FIELDS.map((field) => `  ${field}: readonly string[];`).join("\n")
  + "\n"
  + OPTIONAL_RECORD_FIELDS.map((field) => `  ${field}?: Readonly<Record<string, string>>;`).join("\n")
  + `\n}\n\nexport const BRAND: BrandConfig = ${JSON.stringify(brand, null, 2)} as const;\n\nexport default BRAND;\n`;
writeGenerated("web/src/lib/brand.generated.ts", tsModule);

function rustConst(name, value) {
  const literal = JSON.stringify(value);
  const singleLine = `pub const ${name}: &str = ${literal};`;
  return singleLine.length <= 100
    ? singleLine
    : `pub const ${name}: &str =\n    ${literal};`;
}

const rustBanner = "// AUTO-GENERATED by scripts/sync-brand.mjs - do not edit by hand.\n"
  + `// Active brand: ${brand.id}. Run \`pnpm brand:sync\` with BRAND=<id> to regenerate.\n`;
const rustModule = `${rustBanner}\n${[
  ["BRAND_ID", brand.id],
  ["BRAND_APP_NAME", brand.appName],
  ["BRAND_APP_NAME_EN", brand.appNameEn],
  ["BRAND_PRODUCT_NAME", brand.productName],
  ["BRAND_PROVIDER_KEY", brand.providerKey],
  ["BRAND_SERVICE_URL", brand.serviceUrl],
  ["BRAND_REGISTER_URL", brand.registerUrl],
  ["BRAND_RECHARGE_URL", brand.rechargeUrl],
  ["BRAND_DATA_DIR_NAME", brand.dataDirName],
  ["BRAND_WINDOW_TITLE", windowTitle],
  ["BRAND_HOMEPAGE", brand.homepage],
  ["BRAND_UPDATE_MANIFEST_URL", brand.updateManifestUrl],
  ["BRAND_UPDATE_DOWNLOAD_URL", brand.updateDownloadUrl],
].map(([name, value]) => rustConst(name, value)).join("\n")}\n`;
writeGenerated("src/brand_generated.rs", rustModule);

if (changed.length > 0) {
  if (checkOnly) {
    console.error(`Brand ${JSON.stringify(brand.id)} is not synchronized:`);
    for (const file of changed) console.error(`- ${file}`);
    process.exit(1);
  }
  console.log(`Synchronized brand ${JSON.stringify(brand.id)}:`);
  for (const file of changed) console.log(`- ${file}`);
} else {
  console.log(`Brand ${JSON.stringify(brand.id)} is already synchronized.`);
}
