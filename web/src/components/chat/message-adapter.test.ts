import { describe, expect, it } from "vitest";
import {
  HermesUIMessage as HermesUIMessageSchema,
  MessagesResponse,
  type HermesUIMessage,
  type SessionMessage,
} from "@hermes/protocol";
import {
  attachTurnStatsMetadata,
  deriveAssistantStats,
  hermesUIMessageToChatMessage,
  hermesUIMessagesToChatMessages,
  legacySessionMessagesToHermesUIMessages,
  mergeHermesUIMessages,
  messagesResponseToHermesUIMessages,
  storedMessageToChatMessage,
  storedMessagesToChatMessages,
} from "./message-adapter";

function sessionMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    session_id: "s1",
    role: "assistant",
    content: null,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp: 100,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    reasoning_content: null,
    ...overrides,
  } as SessionMessage;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function uiMessage(overrides: Partial<HermesUIMessage> = {}): HermesUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 1_000,
    status: "complete",
    parts: [{ type: "text", text: "hi" }],
    ...overrides,
  };
}

describe("protocol schemas", () => {
  it("validates canonical Hermes UI messages with text, reasoning, tool, notice, and metadata", () => {
    const parsed = HermesUIMessageSchema.parse(uiMessage({
      parts: [
        { type: "reasoning", text: "plan" },
        { type: "tool", toolCallId: "call-1", name: "read_file", state: "done", output: "ok" },
        { type: "image", url: "https://example.test/chart.png", alt: "chart" },
        { type: "text", text: "done" },
        { type: "notice", level: "warning", text: "quota low" },
      ],
      metadata: {
        usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
        timing: { startedAt: 100, firstTokenAt: 250, completedAt: 900 },
        model: "gpt-5.4",
        finishReason: "stop",
        costUsd: 0.01,
        costStatus: "estimated",
        persistedId: 42,
      },
    }));

    expect(parsed.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool",
      "image",
      "text",
      "notice",
    ]);
    expect(parsed.metadata?.persistedId).toBe(42);
  });

  it("keeps MessagesResponse compatible with legacy messages and optional ui_messages", () => {
    const legacy = MessagesResponse.parse({
      session_id: "s1",
      messages: [sessionMessage({ id: 1, content: "legacy" })],
    });
    const canonical = MessagesResponse.parse({
      session_id: "s1",
      ui_messages: [uiMessage({ id: "ui-1" })],
    });

    expect(legacy.messages).toHaveLength(1);
    expect(canonical.messages).toEqual([]);
    expect(canonical.ui_messages?.[0]?.id).toBe("ui-1");
  });
});

describe("message adapter", () => {
  it("drops historical CLI spinner reasoning placeholders", () => {
    const messages = storedMessagesToChatMessages([
      sessionMessage({
        id: 1,
        content: "任务完成。",
        reasoning_content: "ಠ_ಠ deliberating... (⌐■_■) contemplating...",
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "任务完成。",
      reasoning: undefined,
    });
    expect(messages[0]?.blocks?.map((block) => block.type)).toEqual(["text"]);
  });

  it("keeps historical real reasoning", () => {
    const messages = storedMessagesToChatMessages([
      sessionMessage({
        id: 1,
        content: "任务完成。",
        reasoning_content: "我在检查上下文和约束。",
      }),
    ]);

    expect(messages[0]).toMatchObject({
      text: "任务完成。",
      reasoning: "我在检查上下文和约束。",
    });
    expect(messages[0]?.blocks?.map((block) => block.type)).toEqual([
      "text",
      "reasoning",
    ]);
  });

  it("prefers ui_messages over legacy messages in response adapters", () => {
    const messages = messagesResponseToHermesUIMessages({
      session_id: "s1",
      messages: [sessionMessage({ id: 1, content: "legacy" })],
      ui_messages: [
        uiMessage({ id: "ui-1", parts: [{ type: "text", text: "canonical" }] }),
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "ui-1",
      parts: [{ type: "text", text: "canonical" }],
    });
  });

  it("hides image transport context when rendering stored user prompts", () => {
    const message = hermesUIMessageToChatMessage(uiMessage({
      id: "stored-user-image",
      role: "user",
      parts: [{
        type: "text",
        text: [
          "[Hermes UI Image]",
          "name=ga.png",
          "description:",
          "This image shows a Google Analytics dashboard.",
          "[/Hermes UI Image]",
          "",
          "阅读这张图片的内容",
        ].join("\n"),
      }],
    }));

    expect(message?.text).toBe("阅读这张图片的内容\n\n附件：ga.png");
  });

  it("deduplicates stored image transport prompts against live display prompts", () => {
    const stored = [
      uiMessage({
        id: "stored-user-image",
        role: "user",
        parts: [{
          type: "text",
          text: [
            "[The user attached an image but analysis failed.]",
            "[You can examine it with vision_analyze using image_url: /Users/enzo/Downloads/ga.png]",
            "",
            "[Hermes UI Workspace]",
            "workspace=/Users/enzo/Documents/GithubProjects/hermes/hermes-agent-cn-desktop",
            "instruction=Treat this as the active workspace/root for file paths and shell commands.",
            "[/Hermes UI Workspace]",
            "",
            "[Hermes UI Image]",
            "name=ga.png",
            "description:",
            "[User attached image: ga.png]",
            "[/Hermes UI Image]",
            "",
            "看一下这张图里面是什么内容",
          ].join("\n"),
        }],
      }),
      uiMessage({
        id: "stored-assistant-image",
        role: "assistant",
        parts: [{ type: "text", text: "我已经阅读了这张图片。" }],
      }),
    ];
    const live = [
      uiMessage({
        id: "live-user-image",
        role: "user",
        parts: [{ type: "text", text: "看一下这张图里面是什么内容\n\n附件：ga.png" }],
      }),
      uiMessage({
        id: "live-assistant-image",
        role: "assistant",
        parts: [{ type: "text", text: "我已经阅读了这张图片。" }],
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);
    const chat = hermesUIMessagesToChatMessages(merged);

    expect(merged.map((message) => message.id)).toEqual([
      "live-user-image",
      "live-assistant-image",
    ]);
    expect(chat.map((message) => message.text)).toEqual([
      "看一下这张图里面是什么内容\n\n附件：ga.png",
      "我已经阅读了这张图片。",
    ]);
  });

  it("keeps canonical progress as a streaming progress block", () => {
    const message = hermesUIMessageToChatMessage(uiMessage({
      id: "live-assistant-1",
      status: "streaming",
      parts: [
        { type: "progress", text: "ಠ_ಠ deliberating..." },
      ],
    }));

    expect(message).toMatchObject({
      text: undefined,
      reasoning: undefined,
      status: "streaming",
    });
    expect(message?.blocks).toEqual([{ type: "progress", text: "ಠ_ಠ deliberating..." }]);
  });

  it("preserves structured image parts as renderable chat images", () => {
    const message = hermesUIMessageToChatMessage(uiMessage({
      id: "assistant-image",
      parts: [
        { type: "text", text: "这是图片：" },
        { type: "image", url: "https://example.test/result.png", alt: "生成结果" },
      ],
    }));

    expect(message?.text).toBe("这是图片：");
    expect(message?.images).toEqual([
      expect.objectContaining({
        url: "https://example.test/result.png",
        alt: "生成结果",
      }),
    ]);
    expect(message?.blocks?.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("turns legacy message images fields into image parts instead of dropping them", () => {
    const messages = legacySessionMessagesToHermesUIMessages([
      sessionMessage({
        id: 1,
        role: "user",
        content: "看这张图",
        images: [{ url: "/api/session/s1/files/chart.png", alt: "chart" }],
      }),
    ]);
    const chat = hermesUIMessagesToChatMessages(messages);

    expect(messages[0]?.parts.map((part) => part.type)).toEqual(["text", "image"]);
    expect(chat[0]?.images?.[0]).toMatchObject({
      url: "/api/session/s1/files/chart.png",
      alt: "chart",
    });
  });

  it("merges historical tool call/result pairs into one compact assistant turn", () => {
    const messages = legacySessionMessagesToHermesUIMessages([
      sessionMessage({
        id: 1,
        role: "user",
        content: "配置搜索",
        timestamp: 100,
      }),
      sessionMessage({
        id: 2,
        content: "我先检查配置。",
        tool_calls: [toolCall("call-1", "search_files", { path: "~/.hermes" })],
        timestamp: 101,
      }),
      sessionMessage({
        id: 3,
        role: "tool",
        content: "found .env",
        tool_call_id: "call-1",
        tool_name: "search_files",
        timestamp: 103.5,
      }),
      sessionMessage({
        id: 4,
        tool_calls: [toolCall("call-2", "terminal", { command: "cat ~/.hermes/.env" })],
        timestamp: 104,
      }),
      sessionMessage({
        id: 5,
        role: "tool",
        content: "TAVILY_API_KEY missing",
        tool_call_id: "call-2",
        tool_name: "terminal",
        timestamp: 105.25,
      }),
      sessionMessage({
        id: 6,
        content: "需要补充环境变量。",
        timestamp: 106,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[1]?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "tool",
      "text",
    ]);

    const chat = hermesUIMessagesToChatMessages(messages);
    expect(chat[1]?.tools).toEqual([
      expect.objectContaining({
        tool_id: "call-1",
        status: "done",
        summary: "found .env",
        startedAt: 101_000,
        completedAt: 103_500,
      }),
      expect.objectContaining({
        tool_id: "call-2",
        status: "done",
        summary: "TAVILY_API_KEY missing",
        startedAt: 104_000,
        completedAt: 105_250,
      }),
    ]);
  });

  it("canonical conversion preserves stats, tool cards, reasoning, and copyable text blocks", () => {
    const chat = hermesUIMessageToChatMessage(uiMessage({
      id: "live-assistant-1",
      parts: [
        { type: "reasoning", text: "先分析。" },
        { type: "tool", toolCallId: "read-1", name: "read_file", state: "done", input: { path: "app.tsx" }, output: "ok", startedAt: 100, completedAt: 300 },
        { type: "text", text: "结论。" },
      ],
      metadata: {
        usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
        timing: { startedAt: 0, firstTokenAt: 100, completedAt: 1000 },
        model: "gpt-5.4",
        finishReason: "stop",
      },
    }));

    expect(chat).toMatchObject({
      id: "live-assistant-1",
      reasoning: "先分析。",
      text: "结论。",
      stats: {
        ttftMs: 100,
        durationMs: 1000,
        tokensTotal: 30,
        tokensInput: 10,
        tokensOutput: 20,
        model: "gpt-5.4",
        finishReason: "stop",
      },
    });
    expect(chat?.blocks?.map((block) => block.type)).toEqual(["reasoning", "tool", "text"]);
    expect(chat?.tools?.[0]).toMatchObject({
      tool_id: "read-1",
      name: "read_file",
      status: "done",
      context: "app.tsx",
      summary: "ok",
    });
  });

  it("prefers matching live canonical rows over stored rows to preserve stable ids and stats", () => {
    const stored = legacySessionMessagesToHermesUIMessages([
      sessionMessage({
        id: 1,
        role: "user",
        content: "你好",
        timestamp: 100,
      }),
      sessionMessage({
        id: 2,
        role: "assistant",
        content: "你好，有什么可以帮你？",
        timestamp: 101,
      }),
    ]);
    const live = [
      uiMessage({
        id: "live-user-1",
        role: "user",
        createdAt: 100_000,
        parts: [{ type: "text", text: "你好" }],
      }),
      uiMessage({
        id: "live-assistant-1",
        createdAt: 101_000,
        parts: [{ type: "text", text: "你好，有什么可以帮你？" }],
        metadata: {
          usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
          timing: { startedAt: 100_000, firstTokenAt: 100_200, completedAt: 101_000 },
        },
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);
    const chat = hermesUIMessagesToChatMessages(merged);

    expect(merged.map((message) => message.id)).toEqual([
      "live-user-1",
      "live-assistant-1",
    ]);
    expect(chat[1]?.stats).toMatchObject({
      ttftMs: 200,
      durationMs: 1_000,
      tokensTotal: 30,
    });
  });

  // Regression for issue #98: once a reply completes the stored refetch carries
  // the persisted assistant turn, but the live user prompt can fail to match a
  // stored row (its canonical text diverged), so it was appended *after* the
  // assistant and rendered below the reply. The merge now re-orders by createdAt.
  it("keeps the user prompt above the assistant reply after a completed turn", () => {
    const stored = [
      uiMessage({
        id: "stored-assistant",
        role: "assistant",
        createdAt: 5_001,
        parts: [{ type: "text", text: "这是回复。" }],
      }),
    ];
    const live = [
      uiMessage({
        id: "live-user",
        role: "user",
        createdAt: 5_000,
        parts: [{ type: "text", text: "帮我开发一个项目" }],
      }),
      uiMessage({
        id: "live-assistant",
        role: "assistant",
        status: "streaming",
        createdAt: 5_001,
        parts: [{ type: "text", text: "这是回复。" }],
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);

    expect(merged.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(merged[0]?.id).toBe("live-user");
  });

  // The optimistic user + assistant get the same `now` from startPromptAtom, so
  // the createdAt sort relies on a user-before-assistant tiebreak on exact ties.
  it("orders the user before the assistant when their createdAt ties", () => {
    const stored = [
      uiMessage({
        id: "stored-assistant",
        role: "assistant",
        createdAt: 7_000,
        parts: [{ type: "text", text: "答复" }],
      }),
    ];
    const live = [
      uiMessage({
        id: "live-user",
        role: "user",
        createdAt: 7_000,
        parts: [{ type: "text", text: "问题" }],
      }),
      uiMessage({
        id: "live-assistant",
        role: "assistant",
        status: "streaming",
        createdAt: 7_000,
        parts: [{ type: "text", text: "答复" }],
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);

    expect(merged.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("does not duplicate a stored refetch that matches a live assistant response", () => {
    const stored = legacySessionMessagesToHermesUIMessages([
      sessionMessage({ id: 1, role: "assistant", content: "完成", timestamp: 100 }),
    ]);
    const live = [
      uiMessage({
        id: "live-assistant-10",
        parts: [{ type: "text", text: "完成" }],
        metadata: {
          usage: { tokensOutput: 5 },
          timing: { startedAt: 0, firstTokenAt: 1, completedAt: 10 },
        },
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("live-assistant-10");
  });

  it("keeps persisted stats when a matching live message has no metadata", () => {
    const stored = [
      uiMessage({
        id: "stored-assistant-10",
        parts: [{ type: "text", text: "完成" }],
        metadata: {
          usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
          timing: { startedAt: 1_000, firstTokenAt: 1_250, completedAt: 2_000 },
          model: "deepseek-v4-flash",
        },
      }),
    ];
    const live = [
      uiMessage({
        id: "live-assistant-10",
        parts: [{ type: "text", text: "完成" }],
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);
    const chat = hermesUIMessagesToChatMessages(merged);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("live-assistant-10");
    expect(chat[0]?.stats).toMatchObject({
      ttftMs: 250,
      durationMs: 1_000,
      tokensTotal: 30,
      model: "deepseek-v4-flash",
    });
  });

  it("enriches stored messages from turn stats metadata and scalar columns", () => {
    const messages = [
      uiMessage({
        id: "stored-assistant-20",
        parts: [{ type: "text", text: "完成" }],
        metadata: { finishReason: "stop" },
      }),
    ];

    const enriched = attachTurnStatsMetadata(messages, [
      {
        id: "stat-1",
        sessionId: "s1",
        turnIndex: 1,
        metadata: { usage: { tokensTotal: 30 } },
        model: "deepseek-v4-flash",
        ttftMs: 250,
        durationMs: 1_000,
      },
    ]);
    const chat = hermesUIMessagesToChatMessages(enriched);

    expect(chat[0]?.stats).toMatchObject({
      ttftMs: 250,
      durationMs: 1_000,
      tokensTotal: 30,
      model: "deepseek-v4-flash",
      finishReason: "stop",
    });
  });

  it("prefers stored complete assistant over a stale streaming partial", () => {
    const stored = [
      uiMessage({
        id: "stored-2",
        status: "complete",
        parts: [
          {
            type: "text",
            text: "我是 **MiniMax-M2.7**，通过 **minimax-cn** provider 运行的。你有什么需要帮忙的吗？",
          },
        ],
      }),
    ];
    const live = [
      uiMessage({
        id: "live-assistant-10",
        status: "streaming",
        parts: [
          { type: "text", text: "我是 MiniMax-M2.7" },
          { type: "progress", text: "思考中(耗时较长) 20.4k tokens · MiniMax-M2.7" },
        ],
      }),
    ];

    const merged = mergeHermesUIMessages(stored, live);
    const chat = hermesUIMessagesToChatMessages(merged);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("stored-2");
    expect(merged[0]?.status).toBe("complete");
    expect(chat[0]?.text).toBe("我是 **MiniMax-M2.7**，通过 **minimax-cn** provider 运行的。你有什么需要帮忙的吗？");
    expect(chat[0]?.blocks?.map((block) => block.type)).toEqual(["text"]);
  });

  // Regression for issue #11: stored builds the assistant from multiple
  // non-adjacent text parts (text → tools → text → ...) so textFromParts
  // joins with "" (no separator). The live path can produce the same
  // material with adjacent text parts that `mergeParts` folds with `\n\n`.
  // Before the fix, canonicalText differed by exactly the seam whitespace
  // ("代码。好的" vs "代码。\n\n好的" → after old comparableText collapsing
  // to "代码。 好的") so `===` failed and the assistant rendered twice.
  it("dedups stored vs live assistant when only inter-part whitespace differs", () => {
    const storedAssistant = uiMessage({
      id: "stored-1",
      parts: [
        { type: "text", text: "好的，我先全面了解一下这个项目的结构和代码。" },
        { type: "tool", toolCallId: "c1", name: "read", state: "done" },
        { type: "tool", toolCallId: "c2", name: "read", state: "done" },
        { type: "text", text: "好的，我已经阅读了项目的核心代码。" },
      ],
      metadata: { persistedId: 200 },
    });
    const liveAssistant = uiMessage({
      id: "live-1",
      parts: [
        {
          type: "text",
          text: "好的，我先全面了解一下这个项目的结构和代码。\n\n好的，我已经阅读了项目的核心代码。",
        },
        { type: "tool", toolCallId: "c1", name: "read", state: "done" },
        { type: "tool", toolCallId: "c2", name: "read", state: "done" },
      ],
    });

    const merged = mergeHermesUIMessages([storedAssistant], [liveAssistant]);

    expect(merged).toHaveLength(1);
    // Live wins because it carries richer metadata (the same reason
    // mergeHermesUIMessages prefers consolidated live entries elsewhere).
    expect(merged[0]?.id).toBe("live-1");
  });
});

describe("assistant stats derivation", () => {
  it("derives full stats when metadata usage and timing are present", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: {
            startedAt: 1_000,
            firstTokenAt: 1_420,
            completedAt: 5_200,
          },
          usage: {
            tokensInput: 920,
            tokensOutput: 312,
            tokensTotal: 1232,
            cacheRead: 736,
            cacheWrite: 12,
            apiCalls: 3,
          },
          model: "gpt-5.4",
          costUsd: 0.018,
          costStatus: "ok",
          finishReason: "stop",
        },
      }),
    );

    expect(stats).toMatchObject({
      ttftMs: 420,
      durationMs: 4200,
      tokensTotal: 1232,
      tokensInput: 920,
      tokensOutput: 312,
      cacheRead: 736,
      cacheWrite: 12,
      apiCalls: 3,
      model: "gpt-5.4",
      costUsd: 0.018,
      finishReason: "stop",
    });
    expect(stats?.tokPerSec).toBeCloseTo(312 / 4.2, 2);
  });

  it("keeps metadata costUsd for displayable statuses", () => {
    const estimated = deriveAssistantStats(
      uiMessage({
        metadata: {
          usage: { tokensOutput: 50 },
          costUsd: 0.5,
          costStatus: "estimated",
        },
      }),
    );
    const included = deriveAssistantStats(
      uiMessage({
        metadata: {
          usage: { tokensOutput: 50 },
          costUsd: 0.2,
          costStatus: "included",
        },
      }),
    );

    expect(estimated?.costUsd).toBe(0.5);
    expect(included?.costUsd).toBe(0.2);
  });

  it("omits costUsd when costStatus is explicitly stale or unknown", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: { startedAt: 1_000, firstTokenAt: 1_100, completedAt: 2_000 },
          usage: { tokensOutput: 50 },
          costUsd: 0.5,
          costStatus: "stale_pricing",
        },
      }),
    );
    expect(stats?.costUsd).toBeUndefined();
  });

  it("falls back gracefully when first token never recorded", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: { startedAt: 1_000, completedAt: 3_500 },
          usage: { tokensInput: 100, tokensOutput: 200 },
        },
      }),
    );
    expect(stats?.ttftMs).toBeUndefined();
    expect(stats?.durationMs).toBe(2_500);
    expect(stats?.tokPerSec).toBeCloseTo(200 / 2.5, 2);
  });

  it("returns undefined for non-assistant roles", () => {
    expect(
      deriveAssistantStats(uiMessage({
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { usage: { tokensInput: 10 } },
      })),
    ).toBeUndefined();
  });

  it("returns undefined when neither usage nor timing exists", () => {
    expect(deriveAssistantStats(uiMessage())).toBeUndefined();
  });

  it("attaches stats on canonical assistant messages", () => {
    const chat = hermesUIMessageToChatMessage(uiMessage({
      metadata: {
        timing: { startedAt: 0, firstTokenAt: 200, completedAt: 1_000 },
        usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
      },
    }));
    expect(chat?.stats).toMatchObject({
      ttftMs: 200,
      durationMs: 1_000,
      tokensTotal: 30,
    });
  });

  it("carries legacy token_count into basic stored stats", () => {
    const stored = storedMessageToChatMessage(
      sessionMessage({
        id: 9,
        role: "assistant",
        content: "old reply",
        timestamp: 100,
        token_count: 42,
      }),
    );
    expect(stored?.stats).toMatchObject({ tokensTotal: 42 });
  });
});
