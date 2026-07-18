// Group chat (P-048): `@` completes to room members + `@all` when the composer
// mention source carries members. Mirrors studio's buildMentionOptions.
import { describe, expect, it } from "vitest";

import type { GroupChatMember } from "@hermes/protocol";

import { filterMemberMentions, getMentionCandidates } from "./composer-mentions";

const members: GroupChatMember[] = [
  { profile: "alice", name: "Alice", description: "研究员", agent_id: "alice" },
  { profile: "bob", name: "Bob", description: "工程师", agent_id: "bob" },
];

describe("group chat @ member mentions (P-048)", () => {
  it("bare @ lists @all first, then each member with its role", () => {
    const out = filterMemberMentions(members, "");
    expect(out.map((c) => c.insertText)).toEqual(["@all", "@Alice", "@Bob"]);
    expect(out[0].meta).toBe("所有成员");
    expect(out[1].meta).toBe("研究员");
    expect(out.every((c) => c.kind === "agent")).toBe(true);
  });

  it("filters members by query (and drops @all when it no longer matches)", () => {
    expect(filterMemberMentions(members, "ali").map((c) => c.insertText)).toEqual(["@Alice"]);
    // "al" still prefixes "all" and "alice"
    expect(filterMemberMentions(members, "al").map((c) => c.insertText)).toEqual(["@all", "@Alice"]);
  });

  it("getMentionCandidates routes to members when the source has members", async () => {
    const out = await getMentionCandidates("", { completePath: async () => ({ items: [] }), members });
    expect(out.map((c) => c.insertText)).toEqual(["@all", "@Alice", "@Bob"]);
  });

  it("getMentionCandidates keeps the file/session starters for single chat (no members)", async () => {
    const out = await getMentionCandidates("", { completePath: async () => ({ items: [] }) });
    expect(out.some((c) => c.insertText === "@file:")).toBe(true);
    expect(out.some((c) => c.insertText === "@all")).toBe(false);
  });
});
