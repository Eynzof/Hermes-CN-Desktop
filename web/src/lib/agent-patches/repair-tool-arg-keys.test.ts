/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { repairToolArgKeys } from "./repair-tool-arg-keys";
import type { JSONSchema } from "./types";

function mockSchema(properties: Record<string, JSONSchema>): JSONSchema {
  return {
    name: "test_tool",
    description: "test",
    parameters: {
      type: "object",
      properties,
    },
  };
}

describe("repairToolArgKeys", () => {
  describe("passthroughs", () => {
    it("returns exact matches unchanged", () => {
      const schema = mockSchema({
        path: { type: "string" },
        limit: { type: "integer" },
      });
      const args = { path: "foo.py", limit: 50 };
      const { args: out, repaired } = repairToolArgKeys("test_tool", args, schema);
      expect(out).toEqual(args);
      expect(repaired).toHaveLength(0);
    });

    it("returns empty args", () => {
      const schema = mockSchema({});
      const out = repairToolArgKeys("test_tool", {}, schema);
      expect(out.args).toEqual({});
    });

    it("returns null args as empty object", () => {
      const schema = mockSchema({});
      const out = repairToolArgKeys("test_tool", null, schema);
      expect(out.args).toEqual({});
    });

    it("returns args when schema has no properties", () => {
      const schema: JSONSchema = { name: "test_tool", parameters: { type: "object" } };
      const args = { path: "foo.py" };
      const { args: out, repaired } = repairToolArgKeys("test_tool", args, schema);
      expect(out).toEqual(args);
      expect(repaired).toHaveLength(0);
    });
  });

  describe("alias mapping", () => {
    it("maps file to path", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { file: "foo.py" },
        mockSchema({ path: { type: "string" } }),
      );
      expect(args).toEqual({ path: "foo.py" });
    });

    it("maps cmd to command", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { cmd: "ls" },
        mockSchema({ command: { type: "string" } }),
      );
      expect(args).toEqual({ command: "ls" });
    });

    it("maps q to query", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { q: "python testing" },
        mockSchema({ query: { type: "string" } }),
      );
      expect(args).toEqual({ query: "python testing" });
    });

    it("maps process_id to session_id", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { process_id: "sess-123" },
        mockSchema({ session_id: { type: "string" } }),
      );
      expect(args).toEqual({ session_id: "sess-123" });
    });

    it("maps jobs to tasks", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { jobs: ["a", "b"] },
        mockSchema({ tasks: { type: "array" } }),
      );
      expect(args).toEqual({ tasks: ["a", "b"] });
    });

    it("maps items to todos", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { items: [{ title: "fix bug" }] },
        mockSchema({ todos: { type: "array" } }),
      );
      expect(args).toEqual({ todos: [{ title: "fix bug" }] });
    });

    it("maps search_type to target", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { search_type: "files" },
        mockSchema({ target: { type: "string" } }),
      );
      expect(args).toEqual({ target: "files" });
    });
  });

  describe("fuzzy matching", () => {
    it("repairs single-char typo", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { commmand: "ls" },
        mockSchema({ command: { type: "string" } }),
      );
      expect(args).toEqual({ command: "ls" });
    });

    it("repairs two-char typo", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { backgroud: true },
        mockSchema({ background: { type: "boolean" } }),
      );
      expect(args).toEqual({ background: true });
    });

    it("repairs close miss", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { quesion: "hello" },
        mockSchema({ question: { type: "string" } }),
      );
      expect(args).toEqual({ question: "hello" });
    });
  });

  describe("edge cases", () => {
    it("preserves unknown keys", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { command: "ls", xyz_no_such_key: 123 },
        mockSchema({ command: { type: "string" } }),
      );
      expect(args).toEqual({ command: "ls", xyz_no_such_key: 123 });
    });

    it("repairs multiple keys in one call", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { file: "x.py", cmd: "ls", backgroud: true },
        mockSchema({
          path: { type: "string" },
          command: { type: "string" },
          background: { type: "boolean" },
        }),
      );
      expect(args).toEqual({ path: "x.py", command: "ls", background: true });
    });

    it("does not false-positive fuzzy", () => {
      const { args } = repairToolArgKeys(
        "test_tool",
        { xyz_no_such_key: "nope" },
        mockSchema({
          command: { type: "string" },
          background: { type: "boolean" },
        }),
      );
      expect(args).toEqual({ xyz_no_such_key: "nope" });
    });
  });

  describe("per-tool overrides", () => {
    it("delegate_task maps task to goal", () => {
      const { args } = repairToolArgKeys(
        "delegate_task",
        { task: "write tests" },
        mockSchema({ goal: { type: "string" } }),
      );
      expect(args).toEqual({ goal: "write tests" });
    });

    it("cronjob maps command to action", () => {
      const { args } = repairToolArgKeys(
        "cronjob",
        { command: "create" },
        mockSchema({ action: { type: "string" } }),
      );
      expect(args).toEqual({ action: "create" });
    });

    it("cronjob maps background to no_agent", () => {
      const { args } = repairToolArgKeys(
        "cronjob",
        { background: true },
        mockSchema({ no_agent: { type: "boolean" } }),
      );
      expect(args).toEqual({ no_agent: true });
    });
  });

  describe("recursive repair", () => {
    it("repairs nested object keys", () => {
      const schema = mockSchema({
        config: {
          type: "object",
          properties: {
            path: { type: "string" },
            command: { type: "string" },
          },
        },
      });
      const { args } = repairToolArgKeys(
        "test_tool",
        { config: { file: "x.py", cmd: "ls" } },
        schema,
      );
      expect(args).toEqual({ config: { path: "x.py", command: "ls" } });
    });

    it("repairs array of object keys", () => {
      const schema = mockSchema({
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              command: { type: "string" },
            },
          },
        },
      });
      const { args } = repairToolArgKeys(
        "test_tool",
        { tasks: [{ file: "a.py", cmd: "ls" }, { file: "b.py", cmd: "cat" }] },
        schema,
      );
      expect(args).toEqual({
        tasks: [
          { path: "a.py", command: "ls" },
          { path: "b.py", command: "cat" },
        ],
      });
    });

    it("leaves non-object schemas untouched", () => {
      const schema = mockSchema({
        tags: { type: "array", items: { type: "string" } },
      });
      const { args } = repairToolArgKeys(
        "test_tool",
        { tags: ["a", "b", "c"] },
        schema,
      );
      expect(args).toEqual({ tags: ["a", "b", "c"] });
    });

    it("preserves string value for object-typed key", () => {
      const schema = mockSchema({
        config: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      });
      const { args } = repairToolArgKeys(
        "test_tool",
        { config: "just_a_string" },
        schema,
      );
      expect(args).toEqual({ config: "just_a_string" });
    });
  });
});
