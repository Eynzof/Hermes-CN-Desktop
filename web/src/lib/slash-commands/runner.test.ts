import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "@/lib/session-store/sql";
import { SessionStore } from "@/lib/session-store/session-store";
import { FakeGitDiffProvider } from "@hermes/agent-core";
import { createWebCheckpointStore } from "./handlers/checkpoints";
import { SlashCommandRunner } from "./runner";
import { SkillRegistry } from "@hermes/agent-core";
import type { Skill } from "@hermes/agent-core";

describe("SlashCommandRunner", () => {
  function makeRunner() {
    const adapter = new MemorySqlAdapter();
    const store = new SessionStore({ adapter });
    const prompts: string[] = [];
    let activeSessionId: string | null = null;
    const runner = new SlashCommandRunner();
    const dispatch = async (input: string) => {
      const [name, ...rest] = input.replace(/^\//, "").split(/\s+/);
      const result = await runner.dispatch(name, rest.join(" "), {
        store,
        activeSessionId,
        submitPrompt: async (_sessionId, prompt) => {
          prompts.push(prompt);
        },
        cancelTurn: async () => {},
        notify: () => {},
        cwd: "/tmp",
        dispatchCommand: async () => ({ type: "exec", output: "" }),
      });
      if (result.activeSessionId != null) {
        activeSessionId = result.activeSessionId;
      }
      return { result, prompts };
    };
    return { dispatch, store, runner };
  }

  it("dispatches /new", async () => {
    const { dispatch } = makeRunner();
    const { result } = await dispatch("/new Test");
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBeDefined();
  });

  it("dispatches /title and /branch", async () => {
    const { dispatch } = makeRunner();
    await dispatch("/new");
    const title = await dispatch("/title Hello");
    expect(title.result.type).not.toBe("error");
    const branch = await dispatch("/branch Fix");
    expect(branch.result.type).not.toBe("error");
    expect(branch.result.activeSessionId).toBeDefined();
  });

  it("resolves aliases", async () => {
    const { dispatch } = makeRunner();
    const reset = await dispatch("/reset");
    expect(reset.result.type).not.toBe("error");
    expect(reset.result.activeSessionId).toBeDefined();
  });

  it("completes command names", () => {
    const runner = new SlashCommandRunner();
    expect(runner.complete("res")).toContain("resume");
    expect(runner.complete("sw")).toContain("switch");
  });

  it("dispatches /version locally through the executor", async () => {
    const { runner } = makeRunner();
    const result = await runner.dispatch("version", "", {
      store: new SessionStore({ adapter: new MemorySqlAdapter() }),
      activeSessionId: null,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/tmp",
      dispatchCommand: async () => ({ type: "exec", output: "" }),
      getBuildInfo: () => ({ version: "0.8.0", commit: "abc123", backendVersion: "0.18.0" }),
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Desktop version: 0.8.0");
  });

  it("falls back to backend dispatch for non-local commands", async () => {
    const { runner } = makeRunner();
    const adapter = new MemorySqlAdapter();
    const store = new SessionStore({ adapter });
    const session = await store.create({ source: "test" });

    const result = await runner.dispatch("whoami", "", {
      store,
      activeSessionId: session.id,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/tmp",
      dispatchCommand: async (_sessionId, name, arg) => ({
        type: "exec",
        output: `backend:${name}:${arg}`,
      }),
    });
    expect(result.type).toBe("exec");
    expect(result.output).toBe("backend:whoami:");
  });

  function l1Skill(id: string): Skill {
    return {
      id,
      name: id,
      description: `${id} description`,
      category: "general",
      level: "L1",
      origin: "user",
      metadata: { name: id, description: `${id} description` },
      content: `# ${id}\nRun ${id}.`,
    };
  }

  it("dispatches /skill enable and stack locally", async () => {
    const runner = new SlashCommandRunner();
    const registry = new SkillRegistry();
    registry.register(l1Skill("demo"));
    const result = await runner.dispatch("skill", "enable demo", {
      store: new SessionStore({ adapter: new MemorySqlAdapter() }),
      activeSessionId: null,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/tmp",
      dispatchCommand: async () => ({ type: "exec", output: "" }),
      skillsContext: { registry },
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Enabled");
  });

  it("dispatches /skills bundle locally", async () => {
    const runner = new SlashCommandRunner();
    const registry = new SkillRegistry();
    registry.registerBundle({
      name: "core",
      description: "Core bundle",
      skills: [l1Skill("demo")],
    });
    const result = await runner.dispatch("skills", "bundle core", {
      store: new SessionStore({ adapter: new MemorySqlAdapter() }),
      activeSessionId: null,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/tmp",
      dispatchCommand: async () => ({ type: "exec", output: "" }),
      skillsContext: { registry },
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("core");
    expect(result.output).toContain("demo");
  });

  it("dispatches /rollback /snapshot /diff locally", async () => {
    const runner = new SlashCommandRunner();
    const adapter = new MemorySqlAdapter();
    const store = new SessionStore({ adapter });
    const session = await store.create({ source: "test", cwd: "/workspace" });
    const checkpointStore = createWebCheckpointStore(store, {
      gitDiff: new FakeGitDiffProvider(),
      rewindMessages: async () => 0,
    });

    const snap = await runner.dispatch("snapshot", "test snap", {
      store,
      activeSessionId: session.id,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/workspace",
      dispatchCommand: async () => ({ type: "exec", output: "" }),
      checkpointContext: {
        activeSessionId: session.id,
        store,
        checkpointStore,
        cwd: "/workspace",
      },
    });
    expect(snap.type).toBe("exec");
    expect(snap.output).toContain("Created snapshot");

    const list = await runner.dispatch("rollback", "", {
      store,
      activeSessionId: session.id,
      submitPrompt: async () => {},
      cancelTurn: async () => {},
      notify: () => {},
      cwd: "/workspace",
      dispatchCommand: async () => ({ type: "exec", output: "" }),
      checkpointContext: {
        activeSessionId: session.id,
        store,
        checkpointStore,
        cwd: "/workspace",
      },
    });
    expect(list.type).toBe("exec");
    expect(list.output).toContain("No checkpoints");
  });
});
