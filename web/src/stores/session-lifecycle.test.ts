import { describe, expect, it } from "vitest";
import {
  clearPromptsForSession,
  dequeuePrompt,
  enqueuePrompt,
  removePrompt,
  type QueuedPrompt,
} from "./session-lifecycle";

describe("session-lifecycle atom reducers", () => {
  it("enqueues prompts in FIFO order", () => {
    let queue: QueuedPrompt[] = [];
    queue = enqueuePrompt(queue, "s1", "first", 1, "a");
    queue = enqueuePrompt(queue, "s1", "second", 2, "b");
    expect(queue).toHaveLength(2);
    expect(queue[0].text).toBe("first");
    expect(queue[1].text).toBe("second");
  });

  it("dequeues the oldest prompt", () => {
    let queue: QueuedPrompt[] = [];
    queue = enqueuePrompt(queue, "s1", "first", 1, "a");
    queue = enqueuePrompt(queue, "s1", "second", 2, "b");
    const result = dequeuePrompt(queue);
    expect(result.prompt?.text).toBe("first");
    expect(result.queue).toHaveLength(1);
  });

  it("removes a prompt by id", () => {
    let queue: QueuedPrompt[] = [];
    queue = enqueuePrompt(queue, "s1", "first", 1, "a");
    queue = enqueuePrompt(queue, "s1", "second", 2, "b");
    queue = removePrompt(queue, "a");
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("b");
  });

  it("clears prompts for a session", () => {
    let queue: QueuedPrompt[] = [];
    queue = enqueuePrompt(queue, "s1", "first", 1, "a");
    queue = enqueuePrompt(queue, "s2", "second", 2, "b");
    queue = clearPromptsForSession(queue, "s1");
    expect(queue).toHaveLength(1);
    expect(queue[0].sessionId).toBe("s2");
  });
});
