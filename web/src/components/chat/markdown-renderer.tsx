import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type CSSProperties,
  type ComponentProps,
  type MouseEvent,
} from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import { MessageImage } from "./message-image";
import s from "./markdown-renderer.module.css";

interface MarkdownTextProps {
  text: string;
  streaming?: boolean;
}

type RichInlineProps<T extends "span" | "small" | "time" | "mark"> = Omit<
  ComponentProps<T>,
  "className" | "style"
> & {
  className?: string;
  node?: unknown;
  style?: unknown;
};

const ALLOWED_LINK_PROTOCOLS = ["http", "https", "irc", "ircs", "mailto", "xmpp", "tel", "obsidian"];
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "obsidian:"]);
const BLOCKED_EXTERNAL_PROTOCOLS = /^(?:javascript|data|file|vbscript|tauri):/i;
const KatexSpanContext = createContext(false);

const streamdownPlugins = {
  cjk,
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid,
};

const streamdownLinkSafety: ComponentProps<typeof Streamdown>["linkSafety"] = {
  enabled: false,
};

const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: Array.from(new Set([...(defaultSchema.protocols?.href ?? []), ...ALLOWED_LINK_PROTOCOLS])),
  },
  tagNames: Array.from(new Set([...(defaultSchema.tagNames ?? []), "small", "time", "mark"])),
  attributes: {
    ...defaultSchema.attributes,
    a: Array.from(new Set([...(defaultSchema.attributes?.a ?? []), "title"])),
    span: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    small: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    time: ["dateTime", "datetime", "dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
    mark: ["dataTone", "dataSize", "data-tone", "data-size", "style", "title"],
  },
};

const streamdownRehypePlugins: ComponentProps<typeof Streamdown>["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["tel:", "obsidian:"],
      allowDataImages: true,
    },
  ],
];

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function linePrefix(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index);
}

function fenceAt(text: string, index: number): { marker: "`" | "~"; length: number } | null {
  const prefix = linePrefix(text, index);
  if (!/^[ \t]{0,3}$/.test(prefix)) return null;
  const match = text.slice(index).match(/^(`{3,}|~{3,})/);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  return { marker, length: match[1].length };
}

function closingFenceAt(text: string, index: number, fence: { marker: "`" | "~"; length: number }): boolean {
  const found = fenceAt(text, index);
  return Boolean(found && found.marker === fence.marker && found.length >= fence.length);
}

function tickRunLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === "`") length += 1;
  return length;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) return -1;
    if (!isEscaped(text, found)) return found;
    index = found + needle.length;
  }
  return -1;
}

function normalizeTexMathDelimiters(text: string): string {
  let result = "";
  let index = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineTicks = 0;

  while (index < text.length) {
    if (inlineTicks === 0) {
      const currentFence = fenceAt(text, index);
      if (currentFence) {
        if (fence && closingFenceAt(text, index, fence)) {
          fence = null;
        } else if (!fence) {
          fence = currentFence;
        }
        const length = currentFence.length;
        result += text.slice(index, index + length);
        index += length;
        continue;
      }
    }

    if (!fence && text[index] === "`") {
      const length = tickRunLength(text, index);
      if (inlineTicks === 0) {
        inlineTicks = length;
      } else if (length === inlineTicks) {
        inlineTicks = 0;
      }
      result += text.slice(index, index + length);
      index += length;
      continue;
    }

    if (!fence && inlineTicks === 0 && !isEscaped(text, index)) {
      if (text.startsWith("\\(", index)) {
        const close = findUnescaped(text, "\\)", index + 2);
        if (close !== -1) {
          result += `$${text.slice(index + 2, close)}$`;
          index = close + 2;
          continue;
        }
      }

      if (text.startsWith("\\[", index)) {
        const close = findUnescaped(text, "\\]", index + 2);
        if (close !== -1) {
          result += `\n\n$$\n${text.slice(index + 2, close).trim()}\n$$\n\n`;
          index = close + 2;
          continue;
        }
      }
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || BLOCKED_EXTERNAL_PROTOCOLS.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) return undefined;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return undefined;
    if (url.protocol === "mailto:" && !url.pathname.trim()) return undefined;
    if (url.protocol === "obsidian:" && !url.hostname) return undefined;
    return url.href;
  } catch {
    if (trimmed.startsWith("#")) return trimmed;
    if ((trimmed.startsWith("/") && !trimmed.startsWith("//")) || trimmed.startsWith("./") || trimmed.startsWith("../")) {
      return trimmed;
    }
    return undefined;
  }
}

function isExternalHref(value: string): boolean {
  try {
    const url = new URL(value);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function decodeHashId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function footnoteTargetCandidates(id: string): string[] {
  const decoded = decodeHashId(id);
  const candidates = new Set([id, decoded]);

  for (const candidate of Array.from(candidates)) {
    if (candidate.startsWith("user-content-")) {
      candidates.add(`user-content-${candidate}`);
    } else {
      candidates.add(`user-content-${candidate}`);
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function scrollToHashTarget(hash: string): boolean {
  if (typeof document === "undefined" || !hash.startsWith("#")) return false;
  const id = hash.slice(1);
  if (!id) return false;

  for (const candidate of footnoteTargetCandidates(id)) {
    const target = document.getElementById(candidate);
    if (!target) continue;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }

  return false;
}

function handleHashAnchorClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  scrollToHashTarget(href);
}

function MarkdownAnchor({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  const external = isExternalHref(safe);
  const isHashAnchor = safe.startsWith("#");
  return (
    <a
      {...props}
      href={safe}
      onClick={isHashAnchor ? (event) => handleHashAnchorClick(event, safe) : props.onClick}
      rel={external ? "noreferrer" : undefined}
      target={external && /^https?:\/\//i.test(safe) ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownImage({
  src,
  alt,
  title,
  node: _node,
  ..._props
}: ComponentProps<"img"> & { node?: unknown }) {
  return (
    <MessageImage
      image={{
        url: typeof src === "string" ? src : undefined,
        alt: typeof alt === "string" && alt ? alt : undefined,
        title: typeof title === "string" && title ? title : undefined,
        name: typeof alt === "string" && alt ? alt : undefined,
      }}
    />
  );
}

function classNames(...values: Array<string | false | null | undefined>): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined || undefined;
}

function dataValue(props: Record<string, unknown>, dashed: string, camel: string): string | undefined {
  const value = props[dashed] ?? props[camel];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function toneClass(tone: string | undefined, fallback?: "muted" | "accent" | "subtle") {
  const value = tone || fallback;
  switch (value) {
    case "muted":
    case "secondary":
      return s.toneMuted;
    case "subtle":
    case "faint":
      return s.toneSubtle;
    case "accent":
    case "primary":
      return s.toneAccent;
    default:
      return undefined;
  }
}

function sizeClass(size: string | undefined, fallback?: "small" | "tiny") {
  const value = size || fallback;
  switch (value) {
    case "small":
    case "sm":
      return s.sizeSmall;
    case "tiny":
    case "xs":
      return s.sizeTiny;
    default:
      return undefined;
  }
}

function sanitizeStyleValue(name: string, value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim();
  if (!raw || /url\s*\(|expression\s*\(|[<>]/i.test(raw)) return undefined;

  switch (name) {
    case "color": {
      if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(raw)) return raw;
      if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(raw)) return raw;
      if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(raw)) return raw;
      if (/^var\(--[a-z0-9-]+\)$/i.test(raw)) return raw;
      if (/^(?:currentcolor|inherit|initial|unset)$/i.test(raw)) return raw;
      return undefined;
    }
    case "fontSize": {
      const px = raw.match(/^(\d+(?:\.\d+)?)px$/i);
      if (px) {
        const valuePx = Number(px[1]);
        return valuePx >= 10 && valuePx <= 18 ? raw : undefined;
      }
      const relative = raw.match(/^(\d+(?:\.\d+)?)(em|rem)$/i);
      if (relative) {
        const valueRelative = Number(relative[1]);
        return valueRelative >= 0.65 && valueRelative <= 1.2 ? raw : undefined;
      }
      const percent = raw.match(/^(\d+(?:\.\d+)?)%$/);
      if (percent) {
        const valuePercent = Number(percent[1]);
        return valuePercent >= 65 && valuePercent <= 120 ? raw : undefined;
      }
      return undefined;
    }
    case "opacity": {
      const opacity = Number(raw);
      return Number.isFinite(opacity) && opacity >= 0.35 && opacity <= 1 ? String(opacity) : undefined;
    }
    case "fontWeight": {
      if (/^(?:normal|bold|lighter|bolder)$/i.test(raw)) return raw;
      const weight = Number(raw);
      return Number.isInteger(weight) && weight >= 300 && weight <= 800 ? String(weight) : undefined;
    }
    case "fontStyle": {
      return /^(?:normal|italic)$/i.test(raw) ? raw : undefined;
    }
    case "lineHeight": {
      const lineHeight = Number(raw);
      return Number.isFinite(lineHeight) && lineHeight >= 1 && lineHeight <= 2 ? String(lineHeight) : undefined;
    }
    default:
      return undefined;
  }
}

function toCamelStyleName(name: string): keyof CSSProperties | null {
  switch (name.trim().toLowerCase()) {
    case "color":
      return "color";
    case "font-size":
    case "fontsize":
      return "fontSize";
    case "opacity":
      return "opacity";
    case "font-weight":
    case "fontweight":
      return "fontWeight";
    case "font-style":
    case "fontstyle":
      return "fontStyle";
    case "line-height":
    case "lineheight":
      return "lineHeight";
    default:
      return null;
  }
}

function sanitizeInlineStyle(style: unknown): CSSProperties | undefined {
  const entries: Array<[string, unknown]> = [];

  if (typeof style === "string") {
    for (const declaration of style.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator === -1) continue;
      entries.push([declaration.slice(0, separator), declaration.slice(separator + 1)]);
    }
  } else if (style && typeof style === "object") {
    entries.push(...Object.entries(style as Record<string, unknown>));
  }

  const sanitized: CSSProperties = {};
  for (const [rawName, rawValue] of entries) {
    const name = toCamelStyleName(rawName);
    if (!name) continue;
    const value = sanitizeStyleValue(name, rawValue);
    if (value) {
      (sanitized as Record<string, string>)[name] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function richInlineClassName(
  props: Record<string, unknown>,
  className: string | undefined,
  defaults: { size?: "small" | "tiny"; tone?: "muted" | "accent" | "subtle" } = {},
) {
  return classNames(
    s.richInline,
    toneClass(dataValue(props, "data-tone", "dataTone"), defaults.tone),
    sizeClass(dataValue(props, "data-size", "dataSize"), defaults.size),
    className,
  );
}

function hasRichInlineData(props: Record<string, unknown>): boolean {
  return Boolean(
    dataValue(props, "data-tone", "dataTone") ||
      dataValue(props, "data-size", "dataSize") ||
      props.style ||
      props.title,
  );
}

function MarkdownSpan({ children, className, node: _node, style, ...props }: RichInlineProps<"span">) {
  const insideKatex = useContext(KatexSpanContext);
  const isKatexRoot = typeof className === "string" && /\bkatex\b/.test(className);

  if (insideKatex || isKatexRoot) {
    const span = (
      <span {...props} className={className} style={style as CSSProperties | undefined}>
        {children}
      </span>
    );

    return isKatexRoot ? <KatexSpanContext.Provider value>{span}</KatexSpanContext.Provider> : span;
  }

  const record = props as Record<string, unknown>;
  if (className && !hasRichInlineData(record)) {
    return (
      <span {...props} className={className} style={style as CSSProperties | undefined}>
        {children}
      </span>
    );
  }

  return (
    <span
      {...props}
      className={richInlineClassName(record, className)}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </span>
  );
}

function MarkdownSmall({ children, className, node: _node, style, ...props }: RichInlineProps<"small">) {
  return (
    <small
      {...props}
      className={richInlineClassName(props as Record<string, unknown>, className, { size: "small", tone: "muted" })}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </small>
  );
}

function MarkdownTime({ children, className, node: _node, style, ...props }: RichInlineProps<"time">) {
  return (
    <time
      {...props}
      className={richInlineClassName(props as Record<string, unknown>, className, { size: "small", tone: "muted" })}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </time>
  );
}

function MarkdownMark({ children, className, node: _node, style, ...props }: RichInlineProps<"mark">) {
  return (
    <mark
      {...props}
      className={classNames(s.mark, toneClass(dataValue(props as Record<string, unknown>, "data-tone", "dataTone"), "accent"), className)}
      style={sanitizeInlineStyle(style)}
    >
      {children}
    </mark>
  );
}

const streamdownComponents = {
  a: MarkdownAnchor,
  img: MarkdownImage,
  mark: MarkdownMark,
  small: MarkdownSmall,
  span: MarkdownSpan,
  time: MarkdownTime,
};

// memo：Markdown 解析（streamdown + KaTeX + mermaid）是重量级渲染，父组件
// 与正文无关的 state 变化（编辑器字符计数、保存状态等）不应触发整篇重解析。
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
}: MarkdownTextProps) {
  const normalizedText = useMemo(() => normalizeTexMathDelimiters(text), [text]);

  return (
    <Streamdown
      className={s.markdownRoot}
      components={streamdownComponents}
      controls={false}
      dir="auto"
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={streamdownLinkSafety}
      mode="streaming"
      plugins={streamdownPlugins}
      rehypePlugins={streamdownRehypePlugins}
    >
      {normalizedText}
    </Streamdown>
  );
});
