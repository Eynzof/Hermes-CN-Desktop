import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { skillInvocationPreview } from "@/lib/skill-invocation";
import { MessageText } from "./message-text";
import s from "./message-timeline.module.css";

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
        {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        {expanded ? "收起 Skill 内容" : "展开 Skill 内容"}
      </button>
    </div>
  );
}
