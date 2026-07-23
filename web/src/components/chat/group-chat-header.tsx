import { Users } from "lucide-react";

import type { GroupChatMember } from "@hermes/protocol";
import type { GroupChatChainRuntime } from "@/stores/chat";

import s from "./group-chat-header.module.css";

interface GroupChatHeaderProps {
  members: GroupChatMember[];
  chain?: GroupChatChainRuntime;
  /** Show the "how to address the room" hint (used when the room has no messages yet). */
  showGuide: boolean;
}

// Group chat (P-052): a slim roster bar above the transcript — who is in the
// room + how to address them. Fills the "no idea who's here / how to @" gap
// that made the group chat feel like an ordinary single chat.
export function GroupChatHeader({ members, chain, showGuide }: GroupChatHeaderProps) {
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
      {chain ? (
        <div className={s.chainStatus} role="status" aria-live="polite">
          <span className={s.chainDot} aria-hidden="true" />
          <span>
            接力中
            {chain.activeAgent ? ` · ${chain.activeAgent}` : ""}
            {chain.mentionDepth && chain.mentionDepth > 1
              ? ` · 第 ${chain.mentionDepth} 层`
              : ""}
            {` · ${chain.turns}/${chain.maxTurns} 回合`}
          </span>
        </div>
      ) : null}
      {showGuide ? (
        <div className={s.guide}>
          输入 <b>@名字</b> 单独对话，或直接发送让<b>所有成员</b>都参与；成员可在回复开头
          <b> @另一成员</b> 自动接力。
        </div>
      ) : null}
    </div>
  );
}
