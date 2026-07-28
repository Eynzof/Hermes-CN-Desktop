import fs from "node:fs";
import path from "node:path";

const ROOTS = ["packages/shared-ui/src", "web/src"];
const CSS_FILES = [];
const CODE_FILES = [];

for (const root of ROOTS) walk(root);

const spatialProperty = String.raw`(?:margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|border-radius|border-(?:top-left|top-right|bottom-left|bottom-right)-radius|flex-basis|grid-auto-columns|grid-auto-rows|grid-template-columns|grid-template-rows|scroll-margin(?:-(?:top|right|bottom|left))?|scroll-padding(?:-(?:top|right|bottom|left))?)`;
const cssDeclaration = new RegExp(`(^\\s*|[;{]\\s*)(${spatialProperty})\\s*:\\s*([^;}{]+)`, "gim");
const cssMediaDimension = /\((?:min|max)-(?:width|height)\s*:\s*(-?\d+(?:\.\d+)?)px\)/gi;
const cssPixelTranslation = /\btranslate(?:X|Y)?\([^)]*?\b(-?\d+(?:\.\d+)?)px\b/gi;
const jsxDimension = /\b(size|width|height)=\{(-?\d+(?:\.\d+)?)\}/g;
const styleProperty = "gap|rowGap|columnGap|margin|marginTop|marginRight|marginBottom|marginLeft|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|top|right|bottom|left|width|height|minWidth|minHeight|maxWidth|maxHeight|borderRadius";
const numericStyle = new RegExp(`\\b(${styleProperty})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(?=\\s*[,}])`, "g");
const stringStyle = new RegExp(`\\b(${styleProperty})\\s*:\\s*(["'])([^"']+)\\2`, "g");
const layoutToken = /^--.*(?:space|gap|pad|width|height|radius|offset|inset|row|column|sidebar|bar|control|button|input|card|dialog|switch|tab)/i;
const violations = [];

for (const file of CSS_FILES) {
  const source = fs.readFileSync(file, "utf8");
  checkCss(source, file);
  const tokenPattern = /(--[\w-]+)\s*:\s*([^;}{]+)/g;
  for (const match of source.matchAll(tokenPattern)) {
    const [whole, name, value] = match;
    if (!layoutToken.test(name) || /font-size|line-height|stroke/i.test(name) || name === "--h-radius-pill") continue;
    checkPixels(file, source, match.index, name, value, whole);
  }
}

for (const file of CODE_FILES) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(jsxDimension)) {
    const [, property, raw] = match;
    checkNumber(file, source, match.index, property, Number(raw), match[0]);
  }
  for (const match of source.matchAll(numericStyle)) {
    const [, property, raw] = match;
    checkNumber(file, source, match.index, property, Number(raw), match[0]);
  }
  for (const match of source.matchAll(stringStyle)) {
    checkPixels(file, source, match.index, match[1], match[3], match[0]);
  }
  checkCss(source, file);
}

if (violations.length > 0) {
  console.error(`4px grid check failed with ${violations.length} violation(s):`);
  for (const violation of violations.slice(0, 120)) console.error(`- ${violation}`);
  if (violations.length > 120) console.error(`- ... ${violations.length - 120} more`);
  process.exit(1);
}

console.log(`4px grid check passed (${CSS_FILES.length} CSS files, ${CODE_FILES.length} code files).`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && entry.name.endsWith(".css")) CSS_FILES.push(fullPath);
    else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) CODE_FILES.push(fullPath);
  }
}

function checkCss(source, file) {
  for (const match of source.matchAll(cssDeclaration)) {
    checkPixels(file, source, match.index, match[2].toLowerCase(), match[3], match[0]);
  }
  for (const match of source.matchAll(cssMediaDimension)) {
    checkNumber(file, source, match.index, "media dimension", Number(match[1]), match[0]);
  }
  for (const match of source.matchAll(cssPixelTranslation)) {
    checkNumber(file, source, match.index, "transform", Number(match[1]), match[0]);
  }
}

function checkPixels(file, source, index, property, value, excerpt) {
  if (/radius$/i.test(property) && /\b999px\b/.test(value)) {
    addViolation(file, source, index, property, 999, excerpt);
    return;
  }
  for (const match of value.matchAll(/(-?\d+(?:\.\d+)?)px\b/g)) {
    checkNumber(file, source, index + match.index, property, Number(match[1]), excerpt);
  }
}

function checkNumber(file, source, index, property, value, excerpt) {
  if (value === 0 || Number.isInteger(value / 4)) return;
  // 1px hairlines and the standard visually-hidden 1px box are strokes,
  // not layout units. Border widths are intentionally outside this checker.
  if ((property === "width" || property === "height") && Math.abs(value) === 1) return;
  if (property === "margin" && value === -1) return;
  addViolation(file, source, index, property, value, excerpt);
}

function addViolation(file, source, index, property, value, excerpt) {
  const line = source.slice(0, index).split("\n").length;
  violations.push(`${file}:${line} ${property}=${value} in ${excerpt.trim()}`);
}
