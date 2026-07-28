const SKILL_INVOCATION_RE = /^\s*\[IMPORTANT:\s*The user has invoked the "[^"\r\n]+" (?:stacked skill bundle|skill bundle|skill)\b/i;

/** Runtime 注入的 Skill 指令并非用户实际发送的聊天消息。 */
export function isSkillInvocationText(text: string | null | undefined): boolean {
  return SKILL_INVOCATION_RE.test(text ?? "");
}

export function skillInvocationPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
