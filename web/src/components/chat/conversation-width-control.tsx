import type { KeyboardEvent } from "react";
import {
  CONVERSATION_WIDTH_OPTIONS,
  type ConversationWidthMode,
} from "@/stores/ui";
import s from "./conversation-width-control.module.css";

interface ConversationWidthControlProps {
  value: ConversationWidthMode;
  onChange: (value: ConversationWidthMode) => void;
}

export function ConversationWidthControl({ value, onChange }: ConversationWidthControlProps) {
  const activeIndex = Math.max(
    0,
    CONVERSATION_WIDTH_OPTIONS.findIndex((option) => option.value === value),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null;
    const lastIndex = CONVERSATION_WIDTH_OPTIONS.length - 1;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = activeIndex <= 0 ? lastIndex : activeIndex - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = activeIndex >= lastIndex ? 0 : activeIndex + 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const next = CONVERSATION_WIDTH_OPTIONS[nextIndex]?.value;
    if (!next) return;
    onChange(next);

    const root = event.currentTarget;
    const focusNext = () => {
      root
        .querySelector<HTMLButtonElement>(`button[data-width-value="${next}"]`)
        ?.focus();
    };
    if (typeof window === "undefined") {
      focusNext();
    } else {
      window.requestAnimationFrame(focusNext);
    }
  };

  return (
    <div className={s.control} role="radiogroup" aria-label="对话宽度" onKeyDown={handleKeyDown}>
      <span className={s.label}>宽度</span>
      {CONVERSATION_WIDTH_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`将对话宽度设为${option.title}（${option.value}）`}
            className={s.option}
            data-active={active ? "true" : undefined}
            data-width-value={option.value}
            title={`对话宽度：${option.title}（${option.value}）`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
