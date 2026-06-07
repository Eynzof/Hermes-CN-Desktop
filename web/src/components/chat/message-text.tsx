import { lazy, Suspense } from "react";
import s from "./message-timeline.module.css";

interface MessageTextProps {
  text: string;
  streaming?: boolean;
}

const MarkdownText = lazy(() =>
  import("./markdown-renderer").then((module) => ({
    default: module.MarkdownText,
  })),
);

function InlineText({ text }: Pick<MessageTextProps, "text">) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function PlainMessageText({ text }: Pick<MessageTextProps, "text">) {
  const blocks = text.split(/```/g);

  return (
    <>
      {blocks.map((block, index) => {
        const isCode = index % 2 === 1;
        if (isCode) {
          const lines = block.replace(/^\w+\n/, "").trimEnd();
          return (
            <pre key={index} className={s.codeBlock}>
              <code>{lines}</code>
            </pre>
          );
        }

        return block
          .split(/\n{2,}/)
          .filter((paragraph) => paragraph.length > 0)
          .map((paragraph, paragraphIndex) => (
            <p key={`${index}-${paragraphIndex}`}>
              <InlineText text={paragraph} />
            </p>
          ));
      })}
    </>
  );
}

export function MessageText({ text, streaming = false }: MessageTextProps) {
  return (
    <div className={s.messageText}>
      <Suspense fallback={<PlainMessageText text={text} />}>
        <MarkdownText text={text} streaming={streaming} />
      </Suspense>
    </div>
  );
}
