import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { MessageText } from "./message-text";
import s from "./message-timeline.module.css";

const SKILL_INVOCATION_RE = /^\s*\[IMPORTANT:\s*The user has invoked the "[^"\r\n]+" (?:stacked skill bundle|skill bundle|skill)\b/i;

export function isSkillInvocationText(text: string | null | undefined): boolean {
  return SKILL_INVOCATION_RE.test(text ?? "");
}

export function skillInvocationPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function SkillInvocationMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={s.skillInvocation} data-skill-invocation="true">
      {expanded ? (
        <div className={s.skillInvocationBody}>
          <MessageText text={text} />
        </div>
      ) : (
        <div className={s.skillInvocationPreview}>{skillInvocationPreview(text)}</div>
      )}
      <button
        type="button"
        className={s.skillInvocationToggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        {expanded ? "收起 Skill 内容" : "展开 Skill 内容"}
      </button>
    </div>
  );
}
