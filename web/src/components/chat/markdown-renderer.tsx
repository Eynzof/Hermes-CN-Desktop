import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { MessageImage } from "./message-image";

interface MarkdownTextProps {
  text: string;
  streaming?: boolean;
}

const streamdownPlugins = {
  cjk,
  math: createMathPlugin({ singleDollarTextMath: true }),
};

const streamdownLinkSafety: ComponentProps<typeof Streamdown>["linkSafety"] = {
  enabled: false,
};

function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return undefined;
  return trimmed;
}

function MarkdownAnchor({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  const external = /^https?:\/\//i.test(safe);
  return (
    <a
      {...props}
      href={safe}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
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

const streamdownComponents = { a: MarkdownAnchor, img: MarkdownImage };

export function MarkdownText({ text, streaming = false }: MarkdownTextProps) {
  return (
    <Streamdown
      components={streamdownComponents}
      controls={false}
      dir="auto"
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={streamdownLinkSafety}
      mode="streaming"
      plugins={streamdownPlugins}
    >
      {text}
    </Streamdown>
  );
}
