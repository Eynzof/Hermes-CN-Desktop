import { Users } from "lucide-react";

import type { GroupChatMember } from "@hermes/protocol";

import s from "./group-chat-header.module.css";

interface GroupChatHeaderProps {
  members: GroupChatMember[];
  /** Show the "how to address the room" hint (used when the room has no messages yet). */
  showGuide: boolean;
}

// Group chat (P-048): a slim roster bar above the transcript — who is in the
// room + how to address them. Fills the "no idea who's here / how to @" gap
// that made the group chat feel like an ordinary single chat.
export function GroupChatHeader({ members, showGuide }: GroupChatHeaderProps) {
  if (members.length === 0) return null;
  return (
    <div className={s.header}>
      <div className={s.roster}>
        <Users size={14} aria-hidden="true" />
        <span className={s.count}>{members.length} 位成员</span>
        <div className={s.chips}>
          {members.map((member) => (
            <span
              key={member.agent_id || member.name}
              className={s.chip}
              title={member.description || member.name}
            >
              {member.name}
            </span>
          ))}
        </div>
      </div>
      {showGuide ? (
        <div className={s.guide}>
          输入 <b>@名字</b> 单独对话，或直接发送让<b>所有成员</b>都参与。
        </div>
      ) : null}
    </div>
  );
}
