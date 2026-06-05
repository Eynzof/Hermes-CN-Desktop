#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tauri's DMG bundler embeds plain-text license files as classic TEXT resources.
// macOS decodes those bytes as a legacy Mac encoding in the SLA dialog, which
// turns raw UTF-8 Chinese into mojibake. Keep the source EULA as UTF-8 text, but
// generate an ASCII-only RTF file that stores every non-ASCII character through
// RTF Unicode escapes so both hdiutil and the DMG license dialog can render it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repoRoot, "legal/EULA.zh-CN.txt");
const outputPath = resolve(repoRoot, "legal/EULA.zh-CN.rtf");
const checkOnly = process.argv.includes("--check");

function toSigned16(codeUnit) {
  return codeUnit > 0x7fff ? codeUnit - 0x10000 : codeUnit;
}

function escapeRtfChar(char) {
  switch (char) {
    case "\\":
      return "\\\\";
    case "{":
      return "\\{";
    case "}":
      return "\\}";
    case "\t":
      return "\\tab ";
    case "\r":
      return "";
    case "\n":
      return "\\par\n";
    default:
      break;
  }

  const codePoint = char.codePointAt(0);
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return char;
  }

  const codeUnits = [];
  if (codePoint <= 0xffff) {
    codeUnits.push(codePoint);
  } else {
    const value = codePoint - 0x10000;
    codeUnits.push(0xd800 + (value >> 10));
    codeUnits.push(0xdc00 + (value & 0x3ff));
  }

  return codeUnits.map((unit) => `\\u${toSigned16(unit)}?`).join("");
}

function toRtf(text) {
  const body = Array.from(text, escapeRtfChar).join("");
  return [
    "{\\rtf1\\ansi\\ansicpg936\\deff0\\nouicompat",
    "{\\fonttbl{\\f0\\fnil\\fcharset134 PingFang SC;}}",
    "\\viewkind4\\uc1\\pard\\f0\\fs24\\lang2052 ",
    body,
    "\\par}\n",
  ].join("");
}

const source = readFileSync(sourcePath, "utf8");
const generated = toRtf(source);

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    // handled below
  }
  if (current !== generated) {
    console.error(
      "legal/EULA.zh-CN.rtf is out of date. Run `pnpm run license:sync`.",
    );
    process.exit(1);
  }
  console.log("license RTF is up to date");
} else {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    // created below
  }
  if (current !== generated) {
    writeFileSync(outputPath, generated, "utf8");
    console.log(`generated ${outputPath}`);
  } else {
    console.log(`license RTF already up to date at ${outputPath}`);
  }
}
