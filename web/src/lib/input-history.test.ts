import { beforeEach, describe, expect, it } from "vitest";
import {
  addInputHistoryEntry,
  createInputHistoryManager,
  parseInputHistory,
  recallInputHistory,
  serializeInputHistory,
  type InputHistory,
  type InputHistoryAdapter,
} from "./input-history";
import { __resetUiStoreForTests } from "./ui-store";

describe("input-history core", () => {
  it("ignores empty or whitespace-only entries", () => {
    const history: InputHistory = { entries: [], version: 1 };
    expect(addInputHistoryEntry(history, "   ").entries).toHaveLength(0);
    expect(addInputHistoryEntry(history, "\n\n").entries).toHaveLength(0);
  });

  it("prepends new entries and caps at max", () => {
    let history: InputHistory = { entries: [], version: 1 };
    history = addInputHistoryEntry(history, "first", { cap: 2 });
    history = addInputHistoryEntry(history, "second", { cap: 2 });
    history = addInputHistoryEntry(history, "third", { cap: 2 });
    expect(history.entries.map((e) => e.text)).toEqual(["third", "second"]);
  });

  it("dedupes the immediate previous entry", () => {
    let history: InputHistory = { entries: [], version: 1 };
    history = addInputHistoryEntry(history, "same");
    history = addInputHistoryEntry(history, "same");
    expect(history.entries).toHaveLength(1);
  });

  it("recalls older entries on Up", () => {
    const history: InputHistory = {
      entries: [
        { text: "latest", savedAt: "" },
        { text: "middle", savedAt: "" },
        { text: "oldest", savedAt: "" },
      ],
      version: 1,
    };
    let r = recallInputHistory(history, "older", "", { index: -1, inline: "" });
    expect(r?.text).toBe("latest");
    r = recallInputHistory(history, "older", "", { index: r!.cursor.index, inline: "" });
    expect(r?.text).toBe("middle");
    r = recallInputHistory(history, "older", "", { index: r!.cursor.index, inline: "" });
    expect(r?.text).toBe("oldest");
  });

  it("filters by prefix", () => {
    const history: InputHistory = {
      entries: [
        { text: "deploy prod", savedAt: "" },
        { text: "describe api", savedAt: "" },
        { text: "debug test", savedAt: "" },
      ],
      version: 1,
    };
    const r = recallInputHistory(history, "older", "", { index: -1, inline: "d" });
    expect(r?.text).toBe("deploy prod");
  });

  it("restores the inline draft when recalling newer past the top", () => {
    const history: InputHistory = {
      entries: [{ text: "entry", savedAt: "" }],
      version: 1,
    };
    let r = recallInputHistory(history, "older", "draft", { index: -1, inline: "" });
    expect(r?.text).toBe("entry");
    r = recallInputHistory(history, "newer", "draft", { index: r!.cursor.index, inline: r!.cursor.inline });
    expect(r?.text).toBe("draft");
  });

  it("serializes multiline entries with + prefixes", () => {
    const history: InputHistory = {
      entries: [{ text: "line1\nline2", savedAt: "" }],
      version: 1,
    };
    expect(serializeInputHistory(history)).toBe("line1\n+line2");
  });

  it("parses the + prefixed multiline format", () => {
    const parsed = parseInputHistory("one\n+two\nthree");
    expect(parsed.entries.map((e) => e.text)).toEqual(["one\ntwo", "three"]);
  });
});

describe("input-history manager", () => {
  let adapter: InputHistoryAdapter;
  beforeEach(() => {
    __resetUiStoreForTests({});
    adapter = {
      load: () => ({ entries: [], version: 1 }),
      save: () => {},
    };
  });

  it("persists pushes through the adapter", () => {
    const saves: InputHistory[] = [];
    const a: InputHistoryAdapter = {
      load: adapter.load,
      save: (h) => saves.push(h),
    };
    const manager = createInputHistoryManager(a);
    manager.push("hello");
    manager.push("world");
    expect(saves).toHaveLength(2);
    expect(saves.at(-1)!.entries.map((e) => e.text)).toEqual(["world", "hello"]);
  });

  it("clears all history", () => {
    let saved: InputHistory = { entries: [], version: 1 };
    const manager = createInputHistoryManager({
      load: () => ({ entries: [{ text: "x", savedAt: "" }], version: 1 }),
      save: (h) => { saved = h; },
    });
    manager.reload();
    manager.clear();
    expect(saved.entries).toHaveLength(0);
  });
});

describe("input-history ui-store integration", () => {
  beforeEach(() => {
    __resetUiStoreForTests({});
  });

  it("loads from and saves to the ui-store", () => {
    const manager = createInputHistoryManager();
    manager.push("first");
    const manager2 = createInputHistoryManager();
    expect(manager2.getHistory().entries.map((e) => e.text)).toEqual(["first"]);
  });
});
